import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createStore, DomainError, type Auth, type EmbeddingProvider } from '../packages/core/src/index.ts';
import type { CaptureInput, ExplicitMemory, ExportBundle } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';

const model = 'synthetic-candidate-model';
const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null });
const client = (profile: Auth, permissions = ['capture', 'read']): Auth => ({ ...profile, clientId: 'synthetic-client', permissions });
const failure = (status: number, code: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === code;
function source(origin: 'inferred' | 'assistant_proposed' = 'inferred', text = 'Synthetic review notes may use concise paragraphs.') {
  const eventId = randomUUID();
  const capture: CaptureInput = {
    idempotency_key: randomUUID(), project_id: 'launch', subject: 'self',
    events: [{ id: eventId, text, author_role: origin === 'assistant_proposed' ? 'assistant' : 'user', origin: origin === 'assistant_proposed' ? origin : 'user_explicit' }],
  };
  const candidate: ExplicitMemory = { statement: text, kind: 'preference', source_event_id: eventId, quote: text, origin, effective_at: '2026-10-03T12:00:00Z' };
  return { capture, candidate };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const vectors: EmbeddingProvider = {
  config: { baseUrl: 'http://synthetic.invalid/v1', modelId: 'synthetic-review-vectors', dimensions: 3 },
  embed: async texts => ({ vectors: texts.map(() => [1, 0, 0]), dimensions: 3, model: 'synthetic-review-vectors' }),
};
async function fixture(embeddings?: EmbeddingProvider) {
  const database = await createTestDatabase({ vector: true });
  return { ...database, store: createStore(database.db, { embeddings }), profile: owner(), async runMigration() {
    const sql = await readFile(new URL('../deploy/migrations/005_candidate_review.sql', import.meta.url), 'utf8');
    if ('pglite' in database) await database.pglite.exec(sql);
    else await database.db.query(sql);
  } };
}
async function modelCandidate(store: ReturnType<typeof createStore>, profile: Auth, origin: 'inferred' | 'assistant_proposed' = 'inferred', text?: string) {
  const { capture, candidate } = source(origin, text);
  const receipt = await store.capture(client(profile), capture);
  const processed = await store.processJob({ extract: async () => ({ memories: [candidate], model }) });
  assert.equal(processed?.accepted, 1);
  const status = await store.captureStatus(profile, receipt.capture_id);
  return { capture, candidate, receipt, memoryId: status.memory_ids[0] };
}

test('confirm and edit-and-confirm create distinct owner evidence while retaining model provenance', async () => {
  const { db, store, profile, close } = await fixture(vectors);
  try {
    for (const origin of ['inferred', 'assistant_proposed'] as const) {
      const seed = await modelCandidate(store, profile, origin, `Synthetic ${origin} review notes prefer concise paragraphs.`);
      const before = await store.detail(profile, seed.memoryId);
      assert.equal(before.memory.status, 'candidate');
      assert.equal(before.revisions[0].extractor, model);
      assert.equal((await store.search(client(profile), { query: seed.candidate.statement })).memories.some(memory => memory.id === seed.memoryId), false);
      await store.processEmbeddings();
      assert.equal((await db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows[0].revision, 1);
      await assert.rejects(store.correct(profile, seed.memoryId, { expected_revision: 1, statement: 'Synthetic bypass attempt.' }), failure(409, 'review_required'));
      const edited = origin === 'assistant_proposed' ? 'Synthetic owner confirmed reviews use detailed paragraphs.' : seed.candidate.statement;
      const reviewed = await store.review(profile, seed.memoryId, {
        action: 'confirm', expected_revision: 1,
        ...(origin === 'assistant_proposed' ? { statement: edited, effective_at: null } : {}),
      });
      assert.equal(reviewed.memory.id, seed.memoryId);
      assert.equal(reviewed.memory.revision, 2);
      assert.equal(reviewed.memory.statement, edited);
      assert.equal(reviewed.memory.origin, 'user_confirmed');
      assert.equal(reviewed.memory.status, 'active');
      assert.equal(reviewed.memory.authoritative, true);
      assert.equal(reviewed.memory.extractor, null);
      assert.equal(reviewed.memory.effective_at, origin === 'assistant_proposed' ? null : '2026-10-03T12:00:00.000Z');
      assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows.length, 0, 'Confirmation invalidates candidate vectors even when the text is unchanged.');
      const detail = await store.detail(profile, seed.memoryId);
      assert.equal(detail.sources.length, 2);
      assert.deepEqual(detail.revisions.map(revision => [revision.origin, revision.status, revision.extractor]), [[origin, 'superseded', model], ['user_confirmed', 'active', null]]);
      const old = detail.sources.find(record => record.id === before.sources[0].id)!;
      assert.equal(old.text, before.sources[0].text);
      assert.equal(old.origin, before.sources[0].origin);
      assert.equal(old.author_role, before.sources[0].author_role);
      assert.equal(old.extraction_blocked, true);
      assert.deepEqual(detail.evidence.find(evidence => evidence.revision === 1), before.evidence[0]);
      const current = detail.evidence.find(evidence => evidence.revision === 2)!;
      const confirmation = detail.sources.find(record => record.id === current.source_id)!;
      assert.notEqual(confirmation.id, old.id);
      assert.equal(confirmation.capture_method, 'profile_confirmation');
      assert.equal(confirmation.event_id, `confirmation:${seed.memoryId}:2`);
      assert.equal(confirmation.client_id, 'profile');
      assert.equal(confirmation.author_role, 'user');
      assert.equal(confirmation.origin, 'user_confirmed');
      assert.equal(confirmation.extraction_blocked, true);
      assert.equal(confirmation.text, edited);
      assert.equal(current.quote, edited);
      const recalled = (await store.search(client(profile, ['read']), { query: edited })).memories.find(memory => memory.id === seed.memoryId)!;
      assert.equal(recalled.origin, 'user_confirmed');
      assert.equal(recalled.evidence[0].source_id, confirmation.id);
      await assert.rejects(store.review(profile, seed.memoryId, { action: 'confirm', expected_revision: 2 }), failure(409, 'review_unavailable'));
    }
  } finally { await close(); }
});

test('dismiss preserves candidate interpretation and evidence, excludes recall, and can still be forgotten', async () => {
  const { db, store, profile, close } = await fixture(vectors);
  try {
    const seed = await modelCandidate(store, profile, 'assistant_proposed');
    await store.processEmbeddings();
    assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows.length, 1);
    const before = await store.detail(profile, seed.memoryId);
    await assert.rejects(store.review(profile, seed.memoryId, { action: 'dismiss', expected_revision: 1, statement: 'Changed dismissal.' }), failure(400, 'invalid_input'));
    await assert.rejects(store.review(profile, seed.memoryId, { action: 'dismiss', expected_revision: 1, effective_at: null }), failure(400, 'invalid_input'));
    const dismissed = await store.review(profile, seed.memoryId, { action: 'dismiss', expected_revision: 1 });
    assert.equal(dismissed.memory.status, 'dismissed');
    assert.equal(dismissed.memory.revision, 2);
    assert.equal(dismissed.memory.statement, before.memory.statement);
    assert.equal(dismissed.memory.origin, 'assistant_proposed');
    assert.equal(dismissed.memory.extractor, model);
    assert.equal(dismissed.memory.authoritative, false);
    const detail = await store.detail(profile, seed.memoryId);
    assert.equal(detail.sources.length, 1);
    assert.equal(detail.sources[0].extraction_blocked, true);
    assert.deepEqual(detail.evidence.map(evidence => [evidence.revision, evidence.source_id, evidence.quote]), [[1, before.sources[0].id, before.evidence[0].quote], [2, before.sources[0].id, before.evidence[0].quote]]);
    assert.deepEqual(detail.revisions.map(revision => [revision.status, revision.extractor]), [['superseded', model], ['dismissed', model]]);
    assert.deepEqual((await store.search(client(profile, ['read']), {})).memories, []);
    assert.equal((await store.list(profile, { status: 'candidate' })).memories.length, 0);
    assert.equal((await store.list(profile, { status: 'dismissed' })).memories[0].id, seed.memoryId);
    assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows.length, 0);
    assert.equal((await store.processEmbeddings()).indexed, 0);
    await assert.rejects(store.correct(profile, seed.memoryId, { expected_revision: 2, statement: 'Restore a dismissed proposal.' }), failure(409, 'review_required'));
    await store.remove(profile, seed.memoryId, { expected_revision: 2 });
    assert.equal(JSON.stringify(await store.export(profile)).includes(seed.candidate.statement), false);
    await assert.rejects(store.capture(client(profile), { ...seed.capture, idempotency_key: randomUUID() }), failure(410, 'deleted_source'));
  } finally { await close(); }
});

test('review requires owner permission and scope, and competing actions enforce current revisions', async () => {
  const { store, profile, close } = await fixture();
  try {
    const seed = await modelCandidate(store, profile);
    await assert.rejects(store.review(client(profile), seed.memoryId, { action: 'confirm', expected_revision: 1 }), failure(403, 'permission_denied'));
    await assert.rejects(store.review({ ...profile, projects: ['secret'] }, seed.memoryId, { action: 'confirm', expected_revision: 1 }), failure(404, 'memory_not_found'));
    await assert.rejects(store.review(owner(), seed.memoryId, { action: 'confirm', expected_revision: 1 }), failure(404, 'memory_not_found'));
    const outcomes = await Promise.allSettled([
      store.review(profile, seed.memoryId, { action: 'confirm', expected_revision: 1 }),
      store.review(profile, seed.memoryId, { action: 'dismiss', expected_revision: 1 }),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.ok(outcomes.some(outcome => outcome.status === 'rejected' && failure(409, 'revision_conflict')(outcome.reason)));
    const detail = await store.detail(profile, seed.memoryId);
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.memory.revision, 2);
    await assert.rejects(store.review(profile, seed.memoryId, { action: 'dismiss', expected_revision: 1 }), failure(409, 'revision_conflict'));
    await assert.rejects(store.review(profile, seed.memoryId, { action: 'confirm', expected_revision: 2 }), failure(409, 'review_unavailable'));
    for (const auth of [profile, client(profile)]) {
      await assert.rejects(store.capture(auth, { ...seed.capture, idempotency_key: randomUUID(), events: [{ ...seed.capture.events[0], id: randomUUID(), capture_method: 'profile_confirmation' }] }), failure(400, 'invalid_capture_method'));
    }
  } finally { await close(); }
});

test('edit-and-confirm supersedes matching current siblings and cancels their extraction within the same scope', async () => {
  const { store, profile, close } = await fixture();
  try {
    const old = 'Synthetic project reviews use terse notes.';
    const current = 'Synthetic project reviews use detailed notes.';
    const target = await modelCandidate(store, profile, 'inferred', old);
    const inferred = await modelCandidate(store, profile, 'inferred', old.toUpperCase());
    const rejected = await modelCandidate(store, profile, 'assistant_proposed', old);
    await store.review(profile, rejected.memoryId, { action: 'dismiss', expected_revision: 1 });
    const direct = source('inferred', `  ${old.toLowerCase().replace(/ /g, '  ')}  `);
    direct.candidate.origin = 'user_explicit';
    const saved = await store.capture({ ...client(profile), clientId: 'synthetic-direct' }, { ...direct.capture, explicit_memories: [direct.candidate] });
    const other = source('inferred', old);
    other.capture.project_id = 'unrelated'; other.candidate.origin = 'user_explicit';
    const unrelated = await store.capture(client(profile), { ...other.capture, explicit_memories: [other.candidate] });
    const queued = await store.capture(client(profile), { ...inferred.capture, idempotency_key: randomUUID() });
    const directQueued = await store.capture({ ...client(profile), clientId: 'synthetic-direct' }, { ...direct.capture, idempotency_key: randomUUID() });
    const result = await store.review(profile, target.memoryId, { action: 'confirm', expected_revision: 1, statement: current });
    assert.deepEqual(new Set(result.superseded_memory_ids), new Set([inferred.memoryId, saved.memory_ids[0]]));
    assert.deepEqual((await store.search(profile, { project_id: 'launch' })).memories.map(memory => memory.statement), [current]);
    for (const id of [inferred.memoryId, saved.memory_ids[0]]) {
      const sibling = await store.detail(profile, id);
      assert.equal(sibling.memory.status, 'superseded');
      assert.equal(sibling.memory.authoritative, false);
      assert.ok(sibling.sources.every(record => record.extraction_blocked));
    }
    assert.equal((await store.detail(profile, inferred.memoryId)).revisions[0].extractor, model);
    assert.equal((await store.detail(profile, rejected.memoryId)).memory.status, 'dismissed');
    assert.equal((await store.detail(profile, unrelated.memory_ids[0])).memory.status, 'active');
    assert.equal((await store.getSource(profile, unrelated.source_ids[0])).extraction_blocked, false);
    assert.equal((await store.captureStatus(profile, queued.capture_id)).status, 'cancelled');
    assert.equal((await store.captureStatus(profile, directQueued.capture_id)).status, 'cancelled');
    const recapture = source('inferred', old); recapture.candidate.origin = 'user_explicit';
    assert.deepEqual((await store.capture(client(profile), { ...recapture.capture, explicit_memories: [recapture.candidate] })).memory_ids, []);
    await store.export(profile);
  } finally { await close(); }
});

test('review migration clears obsolete authority and fills only known current provider history on reruns', async () => {
  const { db, store, profile, close, runMigration } = await fixture();
  try {
    const confirmed = await modelCandidate(store, profile);
    await store.review(profile, confirmed.memoryId, { action: 'confirm', expected_revision: 1 });
    await db.query("UPDATE tk_memories SET status='superseded',authoritative=true WHERE id=$1", [confirmed.memoryId]);
    await db.query("UPDATE tk_revisions SET status='superseded' WHERE memory_id=$1 AND revision=2", [confirmed.memoryId]);
    const candidate = await modelCandidate(store, profile, 'inferred', 'Synthetic legacy current candidate provenance.');
    await db.query('UPDATE tk_revisions SET extractor=NULL WHERE memory_id=$1', [candidate.memoryId]);
    const before = await store.detail(profile, confirmed.memoryId);
    await runMigration(); await runMigration();
    const after = await store.detail(profile, confirmed.memoryId);
    assert.equal(after.memory.authoritative, false);
    assert.equal(after.memory.status, 'superseded');
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.revisions, before.revisions);
    assert.equal((await store.detail(profile, candidate.memoryId)).revisions[0].extractor, model);
    await store.export(profile);
  } finally { await close(); }
});

for (const action of ['confirm', 'dismiss'] as const) {
  test(`${action} cancels queued and in-flight extraction, invalidates vectors and fences stale provider output`, async () => {
    const started = gate(); const finish = gate();
    const embedStarted = gate(); const embedFinish = gate();
    let holdEmbedding = false;
    const embeddings: EmbeddingProvider = { ...vectors, embed: async texts => {
      if (holdEmbedding) { embedStarted.resolve(); await embedFinish.promise; }
      return vectors.embed(texts);
    } };
    const { db, store, profile, close } = await fixture(embeddings);
    let worker: ReturnType<typeof store.processJob> | undefined;
    let indexing: ReturnType<typeof store.processEmbeddings> | undefined;
    try {
      const seed = await modelCandidate(store, profile);
      await store.processEmbeddings();
      assert.equal((await db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows[0].revision, 1);
      // Both queued and processing jobs refer to the same stable evidence event.
      const processing = await store.capture(client(profile), { ...seed.capture, idempotency_key: randomUUID() });
      const queued = await store.capture(client(profile), { ...seed.capture, idempotency_key: randomUUID() });
      worker = store.processJob({ extract: async () => { started.resolve(); await finish.promise; return { memories: [seed.candidate], model }; } });
      await started.promise;
      // Reindex a candidate while review is occurring; admission must recheck it.
      await db.query('DELETE FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId]);
      holdEmbedding = true;
      indexing = store.processEmbeddings();
      await embedStarted.promise;
      await store.review(profile, seed.memoryId, { action, expected_revision: 1, ...(action === 'confirm' ? { statement: 'Synthetic owner accepted current review context.' } : {}) });
      for (const receipt of [processing, queued]) assert.equal((await store.captureStatus(profile, receipt.capture_id)).status, 'cancelled');
      finish.resolve(); embedFinish.resolve();
      assert.equal((await worker)?.status, 'cancelled');
      assert.equal((await indexing).indexed, 0);
      assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows.length, 0);
      holdEmbedding = false;
      assert.equal((await store.processEmbeddings()).indexed, action === 'confirm' ? 1 : 0);
      if (action === 'confirm') assert.equal((await db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [seed.memoryId])).rows[0].revision, 2);
      assert.equal((await store.list(profile, { status: 'candidate' })).memories.length, 0);
      const records = (await store.search(client(profile, ['read']), {})).memories;
      assert.deepEqual(records.map(memory => memory.statement), action === 'confirm' ? ['Synthetic owner accepted current review context.'] : []);
    } finally { finish.resolve(); embedFinish.resolve(); await Promise.allSettled([worker, indexing]); await close(); }
  });
}

test('reviewed export/import preserves confirmation, dismissal, provider history and existing correction authority', async () => {
  const { store, profile, close } = await fixture();
  const destination = await fixture();
  try {
    const confirmed = await modelCandidate(store, profile, 'inferred', 'Synthetic inferred owner review preference.');
    await store.review(profile, confirmed.memoryId, { action: 'confirm', expected_revision: 1, statement: 'Synthetic explicitly accepted owner review preference.' });
    const dismissed = await modelCandidate(store, profile, 'assistant_proposed', 'Synthetic dismissed assistant proposal.');
    await store.review(profile, dismissed.memoryId, { action: 'dismiss', expected_revision: 1 });
    const corrected = await modelCandidate(store, profile, 'inferred', 'Synthetic confirmed then corrected preference.');
    await store.review(profile, corrected.memoryId, { action: 'confirm', expected_revision: 1 });
    await store.correct(profile, corrected.memoryId, { expected_revision: 2, statement: 'Synthetic corrected confirmed preference.' });
    const direct = source('inferred', 'Synthetic client reports explicit user confirmation.');
    direct.capture.events[0].origin = 'user_confirmed';
    direct.candidate.origin = 'user_confirmed';
    await store.capture(client(profile), { ...direct.capture, explicit_memories: [direct.candidate] });
    const bundle = await store.export(profile);
    const unblockedDismissal = structuredClone(bundle);
    const dismissedSource = unblockedDismissal.evidence.find(evidence => evidence.memory_id === dismissed.memoryId)!.source_id;
    unblockedDismissal.sources.find(record => record.id === dismissedSource)!.extraction_blocked = false;
    await assert.rejects(destination.store.import(destination.profile, unblockedDismissal), failure(400, 'invalid_review_history'));
    assert.deepEqual((await destination.store.export(destination.profile)).sources, []);
    const imported = await destination.store.import(destination.profile, bundle);
    assert.equal(imported.imported_memories, 4);
    const roundtrip = await destination.store.export(destination.profile);
    assert.deepEqual(roundtrip.memories, bundle.memories);
    assert.deepEqual(roundtrip.revisions, bundle.revisions);
    assert.deepEqual(roundtrip.sources, bundle.sources);
    assert.deepEqual(roundtrip.evidence, bundle.evidence);
    assert.equal((await destination.store.list(destination.profile, { status: 'dismissed' })).memories.length, 1);
    assert.equal((await destination.store.search(destination.profile, {})).memories.length, 3);
    assert.equal((await destination.store.import(destination.profile, bundle)).imported_memories, 0);
    // Old v1 bundles omitted revision-level extractor; null is a supported legacy value.
    const legacy = await fixture();
    try {
      const oldFormat = JSON.parse(JSON.stringify(bundle));
      oldFormat.revisions.forEach((revision: Record<string, unknown>) => { delete revision.extractor; });
      assert.equal((await store.import(profile, oldFormat)).imported_memories, 0, 'Missing legacy extractor metadata does not conflict with known provenance.');
      assert.equal((await legacy.store.import(legacy.profile, oldFormat)).imported_memories, 4);
      await legacy.runMigration();
      assert.equal((await legacy.store.import(legacy.profile, oldFormat)).imported_memories, 0, 'Backfill after restart preserves legacy idempotence.');
    } finally { await legacy.close(); }
  } finally { await close(); await destination.close(); }
});

test('legacy inactive corrected authority imports only with valid correction provenance and remains idempotent', async () => {
  const original = await fixture(), destination = await fixture();
  try {
    const entry = source('inferred', 'Synthetic original deadline is October 20.');
    entry.candidate.origin = 'user_explicit';
    const receipt = await original.store.capture(client(original.profile), { ...entry.capture, explicit_memories: [entry.candidate] });
    const id = receipt.memory_ids[0];
    await original.store.correct(original.profile, id, { expected_revision: 1, statement: 'Synthetic corrected deadline is October 23.' });
    const legacy = await original.store.export(original.profile);
    legacy.memories[0].status = 'superseded';
    legacy.memories[0].authoritative = true;
    legacy.revisions.at(-1)!.status = 'superseded';
    for (const mutate of [
      (bundle: ExportBundle) => { bundle.sources.find(s => s.capture_method === 'profile_correction')!.event_id = 'forged-correction'; },
      (bundle: ExportBundle) => { bundle.sources.find(s => s.capture_method === 'profile_correction')!.extraction_blocked = false; },
    ]) {
      const forged = structuredClone(legacy); mutate(forged);
      await assert.rejects(destination.store.import(destination.profile, forged), failure(400, 'invalid_authority'));
      assert.equal((await destination.store.export(destination.profile)).sources.length, 0);
    }
    assert.equal((await destination.store.import(destination.profile, legacy)).imported_memories, 1);
    const restored = (await destination.store.detail(destination.profile, id)).memory;
    assert.equal(restored.status, 'superseded'); assert.equal(restored.authoritative, false);
    assert.equal(restored.origin, 'user_explicit'); assert.equal(restored.revision, 2);
    assert.equal((await destination.store.search(destination.profile, {})).memories.length, 0);
    assert.equal((await destination.store.import(destination.profile, legacy)).imported_memories, 0);
    await destination.runMigration();
    assert.equal((await destination.store.import(destination.profile, legacy)).imported_memories, 0);
  } finally { await original.close(); await destination.close(); }
});

test('import rejects forged confirmation authority, active model interpretations and unblocked reviewed history atomically', async () => {
  const { store, profile, close } = await fixture();
  const destination = await fixture();
  try {
    const seed = await modelCandidate(store, profile);
    await store.review(profile, seed.memoryId, { action: 'confirm', expected_revision: 1 });
    const bundle = await store.export(profile);
    const mutate: Array<(bundle: ExportBundle) => void> = [
      value => { value.sources.find(record => record.capture_method === 'profile_confirmation')!.capture_method = 'profile_correction'; },
      value => { value.sources.find(record => record.capture_method === 'profile_confirmation')!.event_id = 'confirmation:forged:2'; },
      value => { value.sources.find(record => record.capture_method === 'profile_confirmation')!.client_id = 'forged-editor'; },
      value => { value.sources.find(record => record.capture_method === 'profile_confirmation')!.extraction_blocked = false; },
      value => { value.sources.find(record => record.capture_method !== 'profile_confirmation')!.extraction_blocked = false; },
      value => { value.memories[0].status = 'candidate'; value.revisions[1].status = 'candidate'; },
      value => { value.memories[0].extractor = model; value.revisions[1].extractor = model; },
      value => { value.revisions[1].extractor = 'forged-provider'; },
      value => { value.memories[0].authoritative = false; value.memories[0].origin = 'inferred'; value.revisions[1].origin = 'inferred'; },
      value => { value.revisions[0].status = 'active'; },
    ];
    for (const change of mutate) {
      const forged = structuredClone(bundle); change(forged);
      await assert.rejects(destination.store.import(destination.profile, forged), error => error instanceof DomainError && error.status === 400);
      const after = await destination.store.export(destination.profile);
      assert.deepEqual(after.memories, []);
      assert.deepEqual(after.sources, []);
      assert.deepEqual(after.revisions, []);
      assert.deepEqual(after.evidence, []);
    }
    // Deletion guards also apply to an edited confirmation statement.
    const forgotten = source('inferred', 'Synthetic forgotten text cannot become new owner evidence.');
    forgotten.candidate.origin = 'user_explicit';
    const saved = await store.capture(client(profile), { ...forgotten.capture, explicit_memories: [forgotten.candidate] });
    await store.remove(profile, saved.memory_ids[0], { expected_revision: 1 });
    const candidate = await modelCandidate(store, profile, 'inferred', 'Synthetic new candidate unrelated to forgotten text.');
    await assert.rejects(store.review(profile, candidate.memoryId, { action: 'confirm', expected_revision: 1, statement: forgotten.candidate.statement }), failure(410, 'deleted_content'));
    assert.equal((await store.detail(profile, candidate.memoryId)).memory.status, 'candidate');
  } finally { await close(); await destination.close(); }
});
