import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createStore, DomainError, type Auth, type EmbeddingProvider } from '../packages/core/src/index.ts';
import type { CaptureInput, ExplicitMemory, ExportBundle } from '../packages/contracts/src/index.ts';
import { createTestDatabase, seedLegacyDismissal } from './helpers.ts';

const model = 'synthetic-delivery-model';
const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null });
const client = (profile: Auth, permissions = ['capture', 'read']): Auth => ({ ...profile, clientId: 'synthetic-client', permissions });
const failure = (status: number, code: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === code;
function source(origin: 'user_explicit' | 'agent_reported' | 'inferred' | 'assistant_proposed' = 'inferred', text = 'Synthetic delivery notes may use concise paragraphs.') {
  const eventId = randomUUID();
  const capture: CaptureInput = {
    idempotency_key: randomUUID(), project_id: 'launch', subject: 'self',
    events: [{ id: eventId, text, author_role: ['assistant_proposed', 'agent_reported'].includes(origin) ? 'assistant' : 'user', origin: origin === 'inferred' ? 'user_explicit' : origin }],
  };
  const memory: ExplicitMemory = { statement: text, kind: 'preference', source_event_id: eventId, quote: text, origin, effective_at: '2026-10-03T12:00:00Z' };
  return { capture, memory };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const vectors: EmbeddingProvider = {
  config: { baseUrl: 'http://synthetic.invalid/v1', modelId: 'synthetic-delivery-vectors', dimensions: 3 },
  embed: async texts => ({ vectors: texts.map(() => [1, 0, 0]), dimensions: 3, model: 'synthetic-delivery-vectors' }),
};
async function fixture(embeddings?: EmbeddingProvider) {
  const database = await createTestDatabase({ vector: true });
  return { ...database, store: createStore(database.db, { embeddings }), profile: owner(), async runMigration() {
    const sql = await readFile(new URL('../deploy/migrations/009_automatic_delivery.sql', import.meta.url), 'utf8');
    if (database.db.exec) await database.db.exec(sql); else await database.db.query(sql);
  } };
}
async function learned(store: ReturnType<typeof createStore>, profile: Auth, origin: Parameters<typeof source>[0] = 'inferred', text?: string) {
  const seed = source(origin, text);
  const receipt = await store.capture(client(profile), seed.capture);
  const processed = await store.processJob({ extract: async () => ({ memories: [seed.memory], model }) });
  assert.equal(processed?.accepted, 1);
  const status = await store.captureStatus(profile, receipt.capture_id);
  return { ...seed, receipt, memoryId: status.memory_ids[0] };
}
function legacyCandidate(bundle: ExportBundle, id: string) {
  const memory = bundle.memories.find(memory => memory.id === id)!;
  memory.status = 'candidate';
  bundle.revisions.find(revision => revision.memory_id === id && revision.revision === memory.revision)!.status = 'candidate';
}
function legacyCorrection(bundle: ExportBundle) {
  const correctedSources = new Set(bundle.sources.filter(source => source.capture_method === 'profile_correction').map(source => {
    source.origin = 'user_explicit';
    return source.id;
  }));
  for (const evidence of bundle.evidence.filter(evidence => correctedSources.has(evidence.source_id))) {
    bundle.revisions.find(revision => revision.memory_id === evidence.memory_id && revision.revision === evidence.revision)!.origin = 'user_explicit';
    const memory = bundle.memories.find(memory => memory.id === evidence.memory_id)!;
    if (memory.revision === evidence.revision) memory.origin = 'user_explicit';
  }
}

test('capture and extraction deliver every admitted origin immediately without implying owner endorsement', async () => {
  const { store, profile, close } = await fixture();
  try {
    assert.equal('review' in store, false);
    for (const origin of ['user_explicit', 'agent_reported', 'inferred', 'assistant_proposed'] as const) {
      const direct = source(origin, `Synthetic directly captured ${origin} context.`);
      const captured = await store.capture(client(profile), { ...direct.capture, explicit_memories: [direct.memory] });
      const extracted = await learned(store, profile, origin, `Synthetic extracted ${origin} context.`);
      for (const id of [captured.memory_ids[0], extracted.memoryId]) {
        const detail = await store.detail(profile, id);
        assert.equal(detail.memory.status, 'active');
        assert.equal(detail.memory.origin, origin);
        assert.equal(detail.memory.authoritative, false);
        assert.equal(detail.revisions[0].origin, origin);
        assert.equal(detail.revisions[0].status, 'active');
        assert.equal(detail.sources.length, 1);
        assert.equal(detail.sources[0].capture_method, origin === 'agent_reported' ? 'client_summary' : 'explicit_capture');
        const recalled = (await store.search(client(profile, ['read']), { query: detail.memory.statement })).memories.find(memory => memory.id === id)!;
        assert.equal(recalled.origin, origin);
        assert.equal(recalled.evidence[0].origin, detail.sources[0].origin);
      }
    }
    assert.equal((await store.search(client(profile), {})).memories.length, 8);
    assert.deepEqual((await store.list(profile, { status: 'candidate' })).memories, []);
  } finally { await close(); }
});

test('owner correction immediately delivers authoritative user wording and preserves the original source and interpretation', async () => {
  const { db, store, profile, close } = await fixture(vectors);
  try {
    for (const origin of ['user_explicit', 'agent_reported', 'inferred', 'assistant_proposed'] as const) {
      const seed = await learned(store, profile, origin, `Synthetic ${origin} delivery notes prefer concise paragraphs.`);
      const before = await store.detail(profile, seed.memoryId);
      await store.processEmbeddings();
      assert.equal((await db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows[0].revision, 1);
      const statement = `Synthetic owner corrected ${origin} notes use detailed paragraphs.`;
      const result = await store.correct(profile, seed.memoryId, { expected_revision: 1, statement, effective_at: null });
      assert.equal(result.memory.id, seed.memoryId);
      assert.equal(result.memory.revision, 2);
      assert.equal(result.memory.statement, statement);
      assert.equal(result.memory.origin, 'user_confirmed');
      assert.equal(result.memory.status, 'active');
      assert.equal(result.memory.authoritative, true);
      assert.equal(result.memory.extractor, null);
      assert.equal(result.memory.effective_at, null);
      assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows.length, 0);
      const detail = await store.detail(profile, seed.memoryId);
      assert.deepEqual(detail.revisions.map(revision => [revision.origin, revision.status, revision.extractor]), [[origin, 'superseded', model], ['user_confirmed', 'active', null]]);
      assert.deepEqual(detail.sources.find(record => record.id === before.sources[0].id), { ...before.sources[0], extraction_blocked: true });
      assert.deepEqual(detail.evidence.find(evidence => evidence.revision === 1), before.evidence[0]);
      const evidence = detail.evidence.find(evidence => evidence.revision === 2)!;
      const correction = detail.sources.find(record => record.id === evidence.source_id)!;
      assert.notEqual(correction.id, before.sources[0].id);
      assert.equal(correction.capture_method, 'profile_correction');
      assert.equal(correction.event_id, `correction:${seed.memoryId}:2`);
      assert.equal(correction.client_id, 'profile');
      assert.equal(correction.author_role, 'user');
      assert.equal(correction.origin, 'user_confirmed');
      assert.equal(correction.extraction_blocked, true);
      assert.equal(correction.text, statement);
      assert.equal(evidence.quote, statement);
      const recalled = (await store.search(client(profile, ['read']), { query: statement })).memories.find(memory => memory.id === seed.memoryId)!;
      assert.equal(recalled.origin, 'user_confirmed');
      assert.equal(recalled.evidence[0].source_id, correction.id);
    }
  } finally { await close(); }
});

test('legacy dismissals remain removed from default recall, reject correction and can still be forgotten', async () => {
  const { db, store, profile, close } = await fixture(vectors);
  try {
    const seed = await learned(store, profile, 'assistant_proposed');
    await store.processEmbeddings();
    const before = await store.detail(profile, seed.memoryId);
    await seedLegacyDismissal(db, profile.ownerId, seed.memoryId);
    const detail = await store.detail(profile, seed.memoryId);
    assert.equal(detail.memory.status, 'dismissed');
    assert.equal(detail.memory.origin, 'assistant_proposed');
    assert.equal(detail.memory.authoritative, false);
    assert.equal(detail.sources.length, 1);
    assert.equal(detail.sources[0].extraction_blocked, true);
    assert.deepEqual(detail.revisions.map(revision => [revision.status, revision.extractor]), [['superseded', model], ['dismissed', model]]);
    assert.deepEqual(detail.evidence.map(evidence => [evidence.revision, evidence.source_id, evidence.quote]), [[1, before.sources[0].id, before.evidence[0].quote], [2, before.sources[0].id, before.evidence[0].quote]]);
    assert.deepEqual((await store.search(client(profile, ['read']), {})).memories, []);
    assert.equal((await store.list(profile, { status: 'dismissed' })).memories[0].id, seed.memoryId);
    assert.equal((await store.processEmbeddings()).indexed, 0);
    await assert.rejects(store.correct(profile, seed.memoryId, { expected_revision: 2, statement: 'Restore a dismissed proposal.' }), failure(409, 'correction_unavailable'));
    await store.remove(profile, seed.memoryId, { expected_revision: 2, preview_hash: (await store.previewRemoval(profile, seed.memoryId)).preview_hash });
    assert.equal(JSON.stringify(await store.export(profile)).includes(seed.memory.statement), false);
    await assert.rejects(store.capture(client(profile), { ...seed.capture, idempotency_key: randomUUID() }), failure(410, 'deleted_source'));
  } finally { await close(); }
});

test('correction requires owner permission and scope, and competing corrections enforce current revisions', async () => {
  const { store, profile, close } = await fixture();
  try {
    const seed = await learned(store, profile);
    const input = { expected_revision: 1, statement: 'Synthetic owner corrected delivery preference.' };
    await assert.rejects(store.correct(client(profile), seed.memoryId, input), failure(403, 'permission_denied'));
    await assert.rejects(store.correct({ ...profile, projects: ['secret'] }, seed.memoryId, input), failure(404, 'memory_not_found'));
    await assert.rejects(store.correct(owner(), seed.memoryId, input), failure(404, 'memory_not_found'));
    const outcomes = await Promise.allSettled([
      store.correct(profile, seed.memoryId, input),
      store.correct(profile, seed.memoryId, { ...input, statement: 'Synthetic competing owner wording.' }),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.ok(outcomes.some(outcome => outcome.status === 'rejected' && failure(409, 'revision_conflict')(outcome.reason)));
    assert.equal((await store.detail(profile, seed.memoryId)).revisions.length, 2);
    for (const auth of [profile, client(profile)]) {
      for (const capture_method of ['profile_correction', 'profile_confirmation']) {
        await assert.rejects(store.capture(auth, { ...seed.capture, idempotency_key: randomUUID(), events: [{ ...seed.capture.events[0], id: randomUUID(), capture_method }] }), failure(400, 'invalid_capture_method'));
      }
    }
  } finally { await close(); }
});

test('user correction supersedes matching current siblings and cancels their extraction within the same scope', async () => {
  const { db, store, profile, close } = await fixture();
  try {
    const old = 'Synthetic project updates use terse notes.';
    const current = 'Synthetic project updates use detailed notes.';
    const target = await learned(store, profile, 'inferred', old);
    const inferred = await learned(store, profile, 'inferred', old.toUpperCase());
    const rejected = await learned(store, profile, 'assistant_proposed', old);
    await seedLegacyDismissal(db, profile.ownerId, rejected.memoryId);
    const direct = source('user_explicit', `  ${old.toLowerCase().replace(/ /g, '  ')}  `);
    const saved = await store.capture({ ...client(profile), clientId: 'synthetic-direct' }, { ...direct.capture, explicit_memories: [direct.memory] });
    const other = source('user_explicit', old); other.capture.project_id = 'unrelated';
    const unrelated = await store.capture(client(profile), { ...other.capture, explicit_memories: [other.memory] });
    const queued = await store.capture(client(profile), { ...inferred.capture, idempotency_key: randomUUID() });
    const directQueued = await store.capture({ ...client(profile), clientId: 'synthetic-direct' }, { ...direct.capture, idempotency_key: randomUUID() });
    const result = await store.correct(profile, target.memoryId, { expected_revision: 1, statement: current });
    assert.deepEqual(new Set(result.superseded_memory_ids), new Set([inferred.memoryId, saved.memory_ids[0]]));
    assert.deepEqual((await store.search(profile, { project_id: 'launch' })).memories.map(memory => memory.statement), [current]);
    for (const id of [inferred.memoryId, saved.memory_ids[0]]) {
      const sibling = await store.detail(profile, id);
      assert.equal(sibling.memory.status, 'superseded');
      assert.equal(sibling.memory.authoritative, false);
      assert.ok(sibling.sources.every(record => record.extraction_blocked));
    }
    assert.equal((await store.detail(profile, rejected.memoryId)).memory.status, 'dismissed');
    assert.equal((await store.detail(profile, unrelated.memory_ids[0])).memory.status, 'active');
    assert.equal((await store.getSource(profile, unrelated.source_ids[0])).extraction_blocked, false);
    assert.equal((await store.captureStatus(profile, queued.capture_id)).status, 'cancelled');
    assert.equal((await store.captureStatus(profile, directQueued.capture_id)).status, 'cancelled');
    const recapture = source('user_explicit', old);
    assert.deepEqual((await store.capture(client(profile), { ...recapture.capture, explicit_memories: [recapture.memory] })).memory_ids, []);
  } finally { await close(); }
});

for (const action of ['correct', 'forget'] as const) {
  test(`${action} cancels queued and in-flight extraction and fences stale embedding output`, async () => {
    const started = gate(); const finish = gate(); const embedStarted = gate(); const embedFinish = gate();
    let holdEmbedding = false;
    const embeddings: EmbeddingProvider = { ...vectors, embed: async texts => {
      if (holdEmbedding) { embedStarted.resolve(); await embedFinish.promise; }
      return vectors.embed(texts);
    } };
    const { db, store, profile, close } = await fixture(embeddings);
    let worker: ReturnType<typeof store.processJob> | undefined;
    let indexing: ReturnType<typeof store.processEmbeddings> | undefined;
    try {
      const seed = await learned(store, profile);
      await store.processEmbeddings();
      const processing = await store.capture(client(profile), { ...seed.capture, idempotency_key: randomUUID() });
      const queued = await store.capture(client(profile), { ...seed.capture, idempotency_key: randomUUID() });
      worker = store.processJob({ extract: async () => { started.resolve(); await finish.promise; return { memories: [seed.memory], model }; } });
      await started.promise;
      await db.query('DELETE FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId]);
      holdEmbedding = true; indexing = store.processEmbeddings(); await embedStarted.promise;
      if (action === 'correct') await store.correct(profile, seed.memoryId, { expected_revision: 1, statement: 'Synthetic owner corrected current delivery context.' });
      else await store.remove(profile, seed.memoryId, { expected_revision: 1, preview_hash: (await store.previewRemoval(profile, seed.memoryId)).preview_hash });
      for (const receipt of [processing, queued]) assert.equal((await store.captureStatus(profile, receipt.capture_id)).status, 'cancelled');
      finish.resolve(); embedFinish.resolve();
      assert.equal((await worker)?.status, 'cancelled');
      assert.equal((await indexing).indexed, 0);
      assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows.length, 0);
      holdEmbedding = false;
      assert.equal((await store.processEmbeddings()).indexed, action === 'correct' ? 1 : 0);
      const memories = (await store.search(client(profile, ['read']), {})).memories;
      assert.deepEqual(memories.map(memory => memory.statement), action === 'correct' ? ['Synthetic owner corrected current delivery context.'] : []);
      if (action === 'correct') assert.equal(memories[0].origin, 'user_confirmed');
    } finally { finish.resolve(); embedFinish.resolve(); await Promise.allSettled([worker, indexing]); await close(); }
  });
}

test('automatic delivery migration preserves origins, removals and evidence while normalizing legacy corrections idempotently', async () => {
  const { db, store, profile, close, runMigration } = await fixture();
  try {
    const current = [];
    for (const origin of ['inferred', 'assistant_proposed'] as const) current.push(await learned(store, profile, origin, `Synthetic legacy ${origin} delivery context.`));
    const removed = await learned(store, profile, 'assistant_proposed', 'Synthetic legacy explicitly removed proposal.');
    await seedLegacyDismissal(db, profile.ownerId, removed.memoryId);
    const corrected = await learned(store, profile, 'inferred', 'Synthetic original interpretation before correction.');
    await store.correct(profile, corrected.memoryId, { expected_revision: 1, statement: 'Synthetic earlier owner correction.' });
    await store.correct(profile, corrected.memoryId, { expected_revision: 2, statement: 'Synthetic current owner correction.' });
    const confirmation = await learned(store, profile, 'inferred', 'Synthetic legacy interpretation that was explicitly confirmed.');
    await store.correct(profile, confirmation.memoryId, { expected_revision: 1, statement: 'Synthetic historical explicitly accepted wording.' });
    await db.query("UPDATE tk_sources SET capture_method='profile_confirmation',event_id=$2 WHERE id IN (SELECT source_id FROM tk_evidence WHERE memory_id=$1 AND revision=2)", [confirmation.memoryId, `confirmation:${confirmation.memoryId}:2`]);
    const untouchedOwner = owner();
    const untouched = source('user_explicit', 'Synthetic unaffected owner context.');
    await store.capture(client(untouchedOwner), { ...untouched.capture, explicit_memories: [untouched.memory] });
    const untouchedVersion = (await store.profileOverview(untouchedOwner)).snapshot_version;
    for (const seed of current) {
      await db.query("UPDATE tk_memories SET status='candidate' WHERE id=$1", [seed.memoryId]);
      await db.query("UPDATE tk_revisions SET status='candidate' WHERE memory_id=$1 AND revision=1", [seed.memoryId]);
    }
    await db.query("UPDATE tk_sources SET origin='user_explicit' WHERE owner_id=$1 AND capture_method='profile_correction'", [profile.ownerId]);
    await db.query("UPDATE tk_revisions SET origin='user_explicit' WHERE memory_id=$1 AND revision IN (2,3)", [corrected.memoryId]);
    await db.query("UPDATE tk_memories SET origin='user_explicit' WHERE id=$1", [corrected.memoryId]);
    const before = await store.export(profile);
    const snapshot = (await store.profileOverview(profile)).snapshot_version;
    await runMigration();
    const after = await store.export(profile);
    assert.equal((await store.profileOverview(profile)).snapshot_version, snapshot + 1);
    for (const seed of current) {
      const detail = await store.detail(profile, seed.memoryId);
      assert.equal(detail.memory.status, 'active'); assert.equal(detail.memory.origin, seed.memory.origin);
      assert.equal(detail.revisions[0].status, 'active'); assert.equal(detail.revisions[0].origin, seed.memory.origin);
      assert.equal(detail.memory.authoritative, false);
      assert.deepEqual(detail.sources, before.sources.filter(source => source.id === seed.receipt.source_ids[0]));
    }
    assert.deepEqual(await store.detail(profile, removed.memoryId), {
      memory: before.memories.find(memory => memory.id === removed.memoryId),
      sources: before.sources.filter(source => source.id === removed.receipt.source_ids[0]),
      evidence: before.evidence.filter(evidence => evidence.memory_id === removed.memoryId),
      revisions: before.revisions.filter(revision => revision.memory_id === removed.memoryId),
    });
    const correctedDetail = await store.detail(profile, corrected.memoryId);
    assert.deepEqual(correctedDetail.revisions.map(revision => [revision.origin, revision.status]), [['inferred', 'superseded'], ['user_confirmed', 'superseded'], ['user_confirmed', 'active']]);
    assert(correctedDetail.sources.filter(source => source.capture_method === 'profile_correction').every(source => source.origin === 'user_confirmed'));
    assert.deepEqual(after.evidence, before.evidence);
    const oldConfirmation = await store.detail(profile, confirmation.memoryId);
    assert.equal(oldConfirmation.memory.origin, 'user_explicit');
    assert.deepEqual(oldConfirmation.revisions.map(revision => revision.origin), ['inferred', 'user_explicit']);
    assert.deepEqual(oldConfirmation.sources, before.sources.filter(source => oldConfirmation.sources.some(kept => kept.id === source.id)));
    assert.equal(oldConfirmation.sources.find(source => source.capture_method === 'profile_confirmation')!.origin, 'user_confirmed');
    assert.equal((await store.profileOverview(untouchedOwner)).snapshot_version, untouchedVersion);
    assert.equal((await store.search(client(profile), {})).memories.length, 4);
    await runMigration();
    assert.equal((await store.profileOverview(profile)).snapshot_version, snapshot + 1);
    assert.deepEqual({ ...await store.export(profile), exported_at: null }, { ...after, exported_at: null });
  } finally { await close(); }
});

test('prior migration backfills only current provider history and clears obsolete correction authority on reruns', async () => {
  const { db, store, profile, close } = await fixture();
  try {
    const corrected = await learned(store, profile);
    await store.correct(profile, corrected.memoryId, { expected_revision: 1, statement: 'Synthetic owner corrected migration context.' });
    await db.query("UPDATE tk_memories SET status='superseded',authoritative=true WHERE id=$1", [corrected.memoryId]);
    await db.query("UPDATE tk_revisions SET status='superseded' WHERE memory_id=$1 AND revision=2", [corrected.memoryId]);
    const current = await learned(store, profile, 'inferred', 'Synthetic current provider provenance.');
    await db.query('UPDATE tk_revisions SET extractor=NULL WHERE memory_id=$1', [current.memoryId]);
    const before = await store.detail(profile, corrected.memoryId);
    const sql = await readFile(new URL('../deploy/migrations/005_candidate_review.sql', import.meta.url), 'utf8');
    for (let index = 0; index < 2; index++) { if (db.exec) await db.exec(sql); else await db.query(sql); }
    const after = await store.detail(profile, corrected.memoryId);
    assert.equal(after.memory.authoritative, false); assert.equal(after.memory.status, 'superseded');
    assert.deepEqual(after.sources, before.sources); assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.revisions, before.revisions);
    assert.equal((await store.detail(profile, current.memoryId)).revisions[0].extractor, model);
    await store.export(profile);
  } finally { await close(); }
});

test('import makes legacy candidates available without acceptance and preserves dismissed and corrected history', async () => {
  const original = await fixture(), destination = await fixture();
  try {
    const inferred = await learned(original.store, original.profile, 'inferred', 'Synthetic legacy inferred preference.');
    const proposal = await learned(original.store, original.profile, 'assistant_proposed', 'Synthetic legacy unaccepted assistant proposal.');
    const dismissed = await learned(original.store, original.profile, 'assistant_proposed', 'Synthetic legacy removed assistant proposal.');
    await seedLegacyDismissal(original.db, original.profile.ownerId, dismissed.memoryId);
    const corrected = await learned(original.store, original.profile, 'inferred', 'Synthetic original interpretation.');
    await original.store.correct(original.profile, corrected.memoryId, { expected_revision: 1, statement: 'Synthetic owner corrected interpretation.' });
    const bundle = await original.store.export(original.profile);
    const old = structuredClone(bundle);
    legacyCandidate(old, inferred.memoryId); legacyCandidate(old, proposal.memoryId); legacyCorrection(old);
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 4);
    const roundtrip = await destination.store.export(destination.profile);
    assert.deepEqual(roundtrip.memories, bundle.memories); assert.deepEqual(roundtrip.revisions, bundle.revisions);
    assert.deepEqual(roundtrip.sources, bundle.sources); assert.deepEqual(roundtrip.evidence, bundle.evidence);
    const recalled = (await destination.store.search(destination.profile, {})).memories;
    assert.deepEqual(new Set(recalled.map(memory => memory.origin)), new Set(['inferred', 'assistant_proposed', 'user_confirmed']));
    assert.equal(recalled.length, 3);
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 0);
    const withoutExtractor = JSON.parse(JSON.stringify(old));
    withoutExtractor.revisions.forEach((revision: Record<string, unknown>) => { delete revision.extractor; });
    assert.equal((await destination.store.import(destination.profile, withoutExtractor)).imported_memories, 0);
    await destination.runMigration();
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 0);
  } finally { await original.close(); await destination.close(); }
});

test('legacy confirmation imports remain supported without creating a new confirmation flow', async () => {
  const original = await fixture(), destination = await fixture();
  try {
    const seed = await learned(original.store, original.profile);
    await original.store.correct(original.profile, seed.memoryId, { expected_revision: 1, statement: 'Synthetic explicitly accepted legacy wording.' });
    const old = await original.store.export(original.profile);
    const source = old.sources.find(source => source.capture_method === 'profile_correction')!;
    source.capture_method = 'profile_confirmation'; source.event_id = `confirmation:${seed.memoryId}:2`;
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 1);
    assert.deepEqual((await destination.store.detail(destination.profile, seed.memoryId)).sources, old.sources);
    assert.equal((await destination.store.search(destination.profile, {})).memories[0].origin, 'user_explicit');
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 0);
    assert.equal('review' in destination.store, false);
  } finally { await original.close(); await destination.close(); }
});

test('legacy ordinary user-confirmed capture is delivered as stated context while its captured source remains intact', async () => {
  const original = await fixture(), destination = await fixture();
  try {
    const seed = await learned(original.store, original.profile, 'user_explicit', 'Synthetic ordinary legacy client-reported confirmation.');
    await original.db.query("UPDATE tk_sources SET origin='user_confirmed' WHERE id=$1", [seed.receipt.source_ids[0]]);
    await original.db.query("UPDATE tk_memories SET origin='user_confirmed' WHERE id=$1", [seed.memoryId]);
    await original.db.query("UPDATE tk_revisions SET origin='user_confirmed' WHERE memory_id=$1", [seed.memoryId]);
    const legacy = await original.store.export(original.profile);
    assert.equal(legacy.memories[0].authoritative, false); assert.equal(legacy.memories[0].revision, 1);
    const beforeVersion = (await original.store.profileOverview(original.profile)).snapshot_version;
    await original.runMigration();
    const migrated = await original.store.export(original.profile);
    assert.equal(migrated.memories[0].origin, 'user_explicit');
    assert.equal(migrated.revisions[0].origin, 'user_explicit');
    assert.deepEqual(migrated.sources, legacy.sources); assert.deepEqual(migrated.evidence, legacy.evidence);
    assert.equal((await original.store.profileOverview(original.profile)).snapshot_version, beforeVersion + 1);
    await original.runMigration();
    assert.equal((await original.store.profileOverview(original.profile)).snapshot_version, beforeVersion + 1);
    assert.equal((await destination.store.import(destination.profile, legacy)).imported_memories, 1);
    const imported = await destination.store.export(destination.profile);
    assert.deepEqual(imported.memories, migrated.memories); assert.deepEqual(imported.revisions, migrated.revisions);
    assert.deepEqual(imported.sources, legacy.sources); assert.deepEqual(imported.evidence, legacy.evidence);
    const recalled = (await destination.store.search(destination.profile, {})).memories[0];
    assert.equal(recalled.origin, 'user_explicit'); assert.equal(recalled.evidence[0].origin, 'user_confirmed');
    assert.equal((await destination.store.import(destination.profile, legacy)).imported_memories, 0);
  } finally { await original.close(); await destination.close(); }
});

test('import validates owner evidence, original attribution and removal fences before normalization atomically', async () => {
  const original = await fixture(), destination = await fixture();
  try {
    const seed = await learned(original.store, original.profile);
    await original.store.correct(original.profile, seed.memoryId, { expected_revision: 1, statement: 'Synthetic authoritative owner correction.' });
    const removed = await learned(original.store, original.profile, 'assistant_proposed', 'Synthetic explicitly removed proposal.');
    await seedLegacyDismissal(original.db, original.profile.ownerId, removed.memoryId);
    const bundle = await original.store.export(original.profile);
    const changes: Array<(bundle: ExportBundle) => void> = [
      value => { value.sources.find(source => source.capture_method === 'profile_correction')!.event_id = 'correction:forged:2'; },
      value => { value.sources.find(source => source.capture_method === 'profile_correction')!.client_id = 'forged-editor'; },
      value => { value.sources.find(source => source.capture_method === 'profile_correction')!.extraction_blocked = false; },
      value => { value.sources.find(source => source.id === seed.receipt.source_ids[0])!.extraction_blocked = false; },
      value => { value.memories.find(memory => memory.id === seed.memoryId)!.status = 'candidate'; value.revisions.find(revision => revision.memory_id === seed.memoryId && revision.revision === 2)!.status = 'candidate'; },
      value => { value.memories.find(memory => memory.id === seed.memoryId)!.extractor = model; value.revisions.find(revision => revision.memory_id === seed.memoryId && revision.revision === 2)!.extractor = model; },
      value => { value.revisions.find(revision => revision.memory_id === seed.memoryId && revision.revision === 2)!.extractor = 'forged-provider'; },
      value => { value.revisions.find(revision => revision.memory_id === seed.memoryId && revision.revision === 1)!.status = 'active'; },
      value => { value.sources.find(source => source.id === removed.receipt.source_ids[0])!.extraction_blocked = false; },
      value => { legacyCorrection(value); value.sources.find(source => source.capture_method === 'profile_correction')!.event_id = 'forged-legacy-correction'; },
    ];
    for (const change of changes) {
      const forged = structuredClone(bundle); change(forged);
      await assert.rejects(destination.store.import(destination.profile, forged), error => error instanceof DomainError && error.status === 400);
      const empty = await destination.store.export(destination.profile);
      assert.deepEqual([empty.sources, empty.memories, empty.revisions, empty.evidence], [[], [], [], []]);
    }
    const forgotten = source('user_explicit', 'Synthetic forgotten text cannot become new owner evidence.');
    const saved = await original.store.capture(client(original.profile), { ...forgotten.capture, explicit_memories: [forgotten.memory] });
    await original.store.remove(original.profile, saved.memory_ids[0], { expected_revision: 1, preview_hash: (await original.store.previewRemoval(original.profile, saved.memory_ids[0])).preview_hash });
    const current = await learned(original.store, original.profile, 'inferred', 'Synthetic currently delivered inference.');
    await assert.rejects(original.store.correct(original.profile, current.memoryId, { expected_revision: 1, statement: forgotten.memory.statement }), failure(410, 'deleted_content'));
    assert.equal((await original.store.detail(original.profile, current.memoryId)).memory.origin, 'inferred');
  } finally { await original.close(); await destination.close(); }
});

test('legacy superseded correction authority is validated before normalization and remains removed', async () => {
  const original = await fixture(), destination = await fixture();
  try {
    const seed = await learned(original.store, original.profile, 'user_explicit', 'Synthetic original release deadline.');
    await original.store.correct(original.profile, seed.memoryId, { expected_revision: 1, statement: 'Synthetic corrected release deadline.' });
    const old = await original.store.export(original.profile);
    legacyCorrection(old);
    old.memories[0].status = 'superseded'; old.memories[0].authoritative = true;
    old.revisions.at(-1)!.status = 'superseded';
    for (const mutate of [
      (value: ExportBundle) => { value.sources.find(source => source.capture_method === 'profile_correction')!.event_id = 'forged-correction'; },
      (value: ExportBundle) => { value.sources.find(source => source.capture_method === 'profile_correction')!.extraction_blocked = false; },
    ]) {
      const forged = structuredClone(old); mutate(forged);
      await assert.rejects(destination.store.import(destination.profile, forged), failure(400, 'invalid_authority'));
      assert.deepEqual((await destination.store.export(destination.profile)).sources, []);
    }
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 1);
    const memory = (await destination.store.detail(destination.profile, seed.memoryId)).memory;
    assert.equal(memory.status, 'superseded'); assert.equal(memory.authoritative, false);
    assert.equal(memory.origin, 'user_confirmed'); assert.equal(memory.revision, 2);
    assert.deepEqual((await destination.store.search(destination.profile, {})).memories, []);
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 0);
    await destination.runMigration();
    assert.equal((await destination.store.import(destination.profile, old)).imported_memories, 0);
  } finally { await original.close(); await destination.close(); }
});

test('queued legacy confirmed sources extract as direct statements while preserving captured source attribution', async () => {
  const { db, store, profile, close, runMigration } = await fixture();
  try {
    const seed = source('user_explicit', 'Synthetic queued ordinary legacy client-reported confirmation.');
    const receipt = await store.capture(client(profile), seed.capture);
    await db.query("UPDATE tk_sources SET origin='user_confirmed' WHERE id=$1", [receipt.source_ids[0]]);
    const captured = await store.getSource(profile, receipt.source_ids[0]);
    await runMigration();
    let calls = 0;
    const processed = await store.processJob({ extract: async ({ events }) => {
      calls++;
      assert.equal(events.length, 1); assert.equal(events[0].origin, 'user_explicit');
      assert.equal(events[0].id, seed.capture.events[0].id); assert.equal(events[0].text, captured.text);
      return { model, memories: [seed.memory] };
    } });
    assert.equal(calls, 1); assert.equal(processed?.status, 'complete'); assert.equal(processed?.accepted, 1);
    assert.deepEqual(await store.getSource(profile, receipt.source_ids[0]), captured);
    const recalled = (await store.search(client(profile), {})).memories[0];
    assert.equal(recalled.status, 'active'); assert.equal(recalled.origin, 'user_explicit');
    assert.equal(recalled.evidence[0].source_id, captured.id); assert.equal(recalled.evidence[0].origin, 'user_confirmed');
  } finally { await close(); }
});

test('new capture and worker output cannot claim a user correction', async () => {
  const { store, profile, close } = await fixture();
  try {
    const seed = source('user_explicit', 'Synthetic source that an agent cannot call corrected by the user.');
    await assert.rejects(store.capture(client(profile), { ...seed.capture, events: [{ ...seed.capture.events[0], origin: 'user_confirmed' }] }), failure(400, 'correction_required'));
    await assert.rejects(store.capture(client(profile), { ...seed.capture, explicit_memories: [{ ...seed.memory, origin: 'user_confirmed' }] }), failure(400, 'correction_required'));
    assert.deepEqual((await store.export(profile)).sources, []);
    const receipt = await store.capture(client(profile), seed.capture);
    const result = await store.processJob({ extract: async () => ({ memories: [{ ...seed.memory, origin: 'user_confirmed' }], model }) });
    assert.equal(result?.status, 'failed'); assert(result && 'error_code' in result);
    assert.equal(result.error_code, 'correction_required');
    assert.deepEqual((await store.captureStatus(profile, receipt.capture_id)).memory_ids, []);
  } finally { await close(); }
});
