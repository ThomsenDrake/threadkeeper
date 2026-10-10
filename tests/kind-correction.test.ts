import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createStore, DomainError, type Auth, type EmbeddingProvider } from '../packages/core/src/index.ts';
import type { CaptureInput, ExportBundle } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { migrate } from '../deploy/migrate.ts';

const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null });
const writer = (profile: Auth): Auth => ({ ...profile, clientId: 'kind-client', permissions: ['read', 'capture'] });
const failure = (status: number, code: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === code;
const embeddings: EmbeddingProvider = { config: { baseUrl: 'http://synthetic.invalid/v1', modelId: 'kind-vectors', dimensions: 3 },
  embed: async texts => ({ vectors: texts.map(() => [1, 0, 0]), model: 'kind-vectors', dimensions: 3 }) };
function capture(statement: string): CaptureInput {
  return { idempotency_key: randomUUID(), project_id: 'kind-project', subject: 'self',
    events: [{ id: randomUUID(), text: statement, author_role: 'user', origin: 'user_explicit' }] };
}
async function learned(store: ReturnType<typeof createStore>, profile: Auth, statement: string, origin: 'inferred' | 'user_explicit' = 'user_explicit') {
  const input = capture(statement);
  const receipt = await store.capture(writer(profile), input);
  await store.processJob({ extract: async () => ({ model: 'synthetic-kind-model', memories: [{
    statement, kind: 'fact', source_event_id: input.events[0].id, quote: statement, origin,
  }] }) });
  return { input, id: (await store.captureStatus(profile, receipt.capture_id)).memory_ids[0] };
}
function legacy(bundle: ExportBundle) {
  return { ...bundle, schema_version: 'threadkeeper.export.v1', revisions: bundle.revisions.map(({ kind: _kind, ...revision }) => revision) };
}

test('kind-only owner correction preserves learned history, current identity and forgetting protections', async () => {
  const { db, close } = await createTestDatabase({ vector: true });
  const store = createStore(db, { embeddings }), profile = owner();
  try {
    const statement = 'I prefer written synthetic project updates.';
    const { id } = await learned(store, profile, statement);
    const before = await store.detail(profile, id);
    const identity = (await db.query('SELECT content_key FROM tk_memories WHERE id=$1', [id])).rows[0].content_key;
    await store.processEmbeddings();
    const stalePreview = await store.previewRemoval(profile, id);
    const corrected = await store.correct(profile, id, { expected_revision: 1, statement, kind: 'preference' });
    assert.equal(corrected.memory.kind, 'preference');
    assert.equal(corrected.memory.id, id);
    assert.equal(corrected.memory.statement, statement);
    assert.equal(corrected.memory.created_at, before.memory.created_at);
    assert.equal(corrected.memory.revision, 2);
    assert.equal(corrected.memory.authoritative, true);
    assert.equal(corrected.memory.extractor, null);
    assert.equal((await db.query('SELECT content_key FROM tk_memories WHERE id=$1', [id])).rows[0].content_key, identity);
    assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [id])).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM tk_embedding_attempts WHERE memory_id=$1', [id])).rows.length, 0);
    const detail = await store.detail(profile, id);
    assert.deepEqual(detail.revisions.map(revision => [revision.kind, revision.extractor, revision.status]),
      [['fact', 'synthetic-kind-model', 'superseded'], ['preference', null, 'active']]);
    assert.deepEqual(detail.sources.find(source => source.id === before.sources[0].id), { ...before.sources[0], extraction_blocked: true });
    assert.deepEqual(detail.evidence[0], before.evidence[0]);
    const source = detail.sources.find(source => source.id === detail.evidence[1].source_id)!;
    assert.equal(source.capture_method, 'profile_correction');
    assert.equal(source.text, statement);
    assert.equal(source.client_id, 'profile');
    assert.equal((await store.search(writer(profile), {})).memories[0].kind, 'preference');
    await assert.rejects(store.correct(profile, id, { expected_revision: 1, statement, kind: 'constraint' }), failure(409, 'revision_conflict'));
    await assert.rejects(store.correct(writer(profile), id, { expected_revision: 2, statement, kind: 'constraint' }), failure(403, 'permission_denied'));
    await assert.rejects(store.correct(profile, id, { expected_revision: 2, statement, kind: 'other' }), failure(400, 'invalid_input'));
    assert.deepEqual(await store.detail(profile, id), detail, 'Rejected writes leave canonical history unchanged.');
    await assert.rejects(store.remove(profile, id, { expected_revision: 2, preview_hash: stalePreview.preview_hash }), failure(409, 'deletion_preview_conflict'));
    const omitted = await store.correct(profile, id, { expected_revision: 2, statement });
    assert.equal(omitted.memory.kind, 'preference');
    await store.processEmbeddings();
    assert.equal((await db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [id])).rows[0].revision, 3);
    await store.remove(profile, id, { expected_revision: 3, preview_hash: (await store.previewRemoval(profile, id)).preview_hash });
    const replay = capture(statement);
    replay.explicit_memories = [{ statement, kind: 'constraint', origin: 'user_explicit', source_event_id: replay.events[0].id, quote: statement }];
    await assert.rejects(store.capture(writer(profile), replay), failure(410, 'deleted_source'));
    assert.equal((await store.export(profile)).memories.length, 0);
  } finally { await close(); }
});

test('an inferred memory can be corrected immediately, with or without changing its kind', async () => {
  const { db, close } = await createTestDatabase();
  const store = createStore(db), profile = owner();
  try {
    for (const changeKind of [true, false]) {
      const statement = `Synthetic ${changeKind ? 'kind-changing' : 'wording-only'} inferred assertion.`;
      const { id } = await learned(store, profile, statement, 'inferred');
      const result = await store.correct(profile, id, { expected_revision: 1, statement: `${statement} Corrected by its owner.`,
        ...(changeKind ? { kind: 'decision' } : {}) });
      const expected = changeKind ? 'decision' : 'fact';
      assert.equal(result.memory.kind, expected);
      const detail = await store.detail(profile, id);
      assert.deepEqual(detail.revisions.map(revision => revision.kind), ['fact', expected]);
      assert.equal(detail.revisions[0].extractor, 'synthetic-kind-model');
      assert.equal(detail.sources.length, 2);
      assert.equal(detail.memory.origin, 'user_confirmed');
      assert.equal(detail.sources.find(source => source.capture_method === 'profile_correction')!.origin, 'user_confirmed');
    }
  } finally { await close(); }
});

test('v2 round trips kind history and original admission identity; strict legacy import cannot overwrite it', async () => {
  const first = await createTestDatabase(), second = await createTestDatabase(), third = await createTestDatabase();
  const store = createStore(first.db), restored = createStore(second.db), profile = owner(), destination = owner();
  try {
    const statement = 'I prefer a synthetic written handoff.';
    const { id, input } = await learned(store, profile, statement);
    const old = legacy(await store.export(profile));
    await store.correct(profile, id, { expected_revision: 1, statement, kind: 'preference' });
    const bundle = await store.export(profile);
    assert.equal(bundle.schema_version, 'threadkeeper.export.v2');
    assert.equal((await restored.import(destination, bundle)).imported_memories, 1);
    assert.equal((await restored.import(destination, bundle)).existing_memories, 1);
    const saved = await restored.export(destination);
    assert.deepEqual({ ...saved, exported_at: null }, { ...bundle, exported_at: null });
    const key = async (database: typeof first) => (await database.db.query('SELECT content_key FROM tk_memories WHERE id=$1', [id])).rows[0].content_key;
    assert.equal(await key(first), await key(second));
    await restored.capture(writer(destination), { ...input, idempotency_key: randomUUID(), explicit_memories: [{ statement, kind: 'fact', origin: 'user_explicit', source_event_id: input.events[0].id, quote: statement }] });
    assert.equal((await restored.export(destination)).memories.length, 1);
    await assert.rejects(restored.import(destination, old), failure(409, 'import_source_conflict'));
    const missing = JSON.parse(JSON.stringify(bundle)); delete missing.revisions[0].kind;
    await assert.rejects(restored.import(owner(), missing), failure(400, 'invalid_input'));
    const mismatch = structuredClone(bundle); mismatch.revisions.at(-1)!.kind = 'constraint';
    await assert.rejects(restored.import(owner(), mismatch), failure(400, 'revision_mismatch'));
    const historical = structuredClone(bundle); historical.revisions[0].kind = 'project_state';
    await assert.rejects(restored.import(destination, historical), failure(409, 'import_revision_conflict'));
    assert.deepEqual({ ...await restored.export(destination), exported_at: null }, { ...saved, exported_at: null });
    const legacyOwner = owner(), legacyStore = createStore(third.db);
    const withoutExtractor = JSON.parse(JSON.stringify(old)); delete withoutExtractor.revisions[0].extractor;
    assert.equal((await legacyStore.import(legacyOwner, withoutExtractor)).imported_memories, 1);
    assert.equal((await legacyStore.import(legacyOwner, old)).existing_memories, 1);
    assert.deepEqual((await legacyStore.detail(legacyOwner, id)).revisions.map(revision => [revision.kind, revision.extractor]), [['fact', 'synthetic-kind-model']]);
    await legacyStore.correct(legacyOwner, id, { statement, expected_revision: 1, kind: 'decision' });
    await assert.rejects(legacyStore.import(legacyOwner, old), failure(409, 'import_source_conflict'));
    assert.deepEqual((await legacyStore.detail(legacyOwner, id)).revisions.map(revision => revision.kind), ['fact', 'decision']);
  } finally { await first.close(); await second.close(); await third.close(); }
});

test('kind-only changes fence a held embedding response and rebuild the new revision', async () => {
  const { db, close } = await createTestDatabase({ vector: true });
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const store = createStore(db, { embeddings: { ...embeddings, embed: async texts => {
    if (first) { first = false; started(); await held; }
    return embeddings.embed(texts);
  } } }), profile = owner();
  try {
    const statement = 'I prefer synthetic async status reports.';
    const { id } = await learned(store, profile, statement);
    const indexing = store.processEmbeddings();
    await pending;
    await store.correct(profile, id, { statement, expected_revision: 1, kind: 'preference' });
    release(); await indexing;
    assert.equal((await db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [id])).rows.length, 0);
    await store.processEmbeddings();
    assert.equal((await db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [id])).rows[0].revision, 2);
  } finally { release(); await close(); }
});

test('upgrade backfills immutable legacy kinds and rerunning preserves changed history', async () => {
  const { db, close } = await createTestDatabase({ vector: true });
  const store = createStore(db), profile = owner();
  try {
    const statement = 'A synthetic migration assertion.';
    const { id } = await learned(store, profile, statement);
    await store.correct(profile, id, { statement, expected_revision: 1 });
    await db.query('ALTER TABLE tk_revisions DROP COLUMN kind');
    await migrate(db);
    assert.deepEqual((await store.detail(profile, id)).revisions.map(revision => revision.kind), ['fact', 'fact']);
    await store.correct(profile, id, { statement, expected_revision: 2, kind: 'decision' });
    const sql = await readFile(new URL('../deploy/migrations/008_revision_kind.sql', import.meta.url), 'utf8');
    if (db.exec) await db.exec(sql); else await db.query(sql);
    assert.deepEqual((await store.detail(profile, id)).revisions.map(revision => revision.kind), ['fact', 'fact', 'decision']);
    assert.equal((await migrate(db)).applied, 0);
    await assert.rejects(db.query("UPDATE tk_revisions SET kind='invalid' WHERE memory_id=$1", [id]));
  } finally { await close(); }
});
