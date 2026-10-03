import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { createStore, DomainError, type Auth } from '../packages/core/src/index.ts';
import type { CaptureInput, ExplicitMemory } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { syntheticEmbeddings } from './hybrid-fixtures.ts';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => { fixture = await createTestDatabase({ vector: true }); });
afterEach(async () => { await fixture.db.query('TRUNCATE tk_owners CASCADE'); });
after(async () => { await fixture.close(); });

function principals() {
  const profile: Auth = { ownerId: randomUUID(), clientId: 'profile', permissions: ['read', 'capture', 'correct', 'delete', 'export', 'import'], projects: null };
  return {
    profile,
    clientA: { ...profile, clientId: 'client-a', permissions: ['read', 'capture'] },
    clientB: { ...profile, clientId: 'client-b', permissions: ['read'] },
  };
}
function captureInput(statement: string, options: Partial<CaptureInput> = {}, memory: Partial<ExplicitMemory> = {}): CaptureInput {
  const eventId = randomUUID();
  return {
    idempotency_key: randomUUID(), project_id: 'launch', subject: 'self',
    events: [{ id: eventId, text: statement, author_role: 'user', origin: 'user_explicit', occurred_at: '2026-10-01T12:00:00Z' }],
    explicit_memories: [{ statement, kind: 'fact', origin: 'user_explicit', source_event_id: eventId, quote: statement, ...memory }],
    ...options,
  };
}
const hasError = (status: number, code: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === code;
const statements = (result: Awaited<ReturnType<ReturnType<typeof createStore>['search']>>) => result.memories.map(memory => memory.statement).sort();
async function storedVectors(memoryId?: string) {
  return (await fixture.db.query(`SELECT * FROM tk_embeddings${memoryId ? ' WHERE memory_id=$1' : ''}`, memoryId ? [memoryId] : [])).rows;
}

test('hybrid recall finds a paraphrase through pgvector while credential-free lexical retrieval still works', async () => {
  const { clientA, clientB } = principals();
  const statement = 'Use brief paragraphs when drafting documents.';
  const query = 'writing style';
  const embeddings = syntheticEmbeddings({ [statement]: [1, 0, 0, 0], [query]: [1, 0, 0, 0] });
  const store = createStore(fixture.db, { embeddings });
  await store.capture(clientA, captureInput(statement, {}, { kind: 'preference' }));
  const lexical = createStore(fixture.db);
  assert.deepEqual(statements(await lexical.search(clientB, { query })), []);
  assert.deepEqual(statements(await lexical.search(clientB, { query: 'paragraphs' })), [statement]);
  assert.equal((await lexical.search(clientB, { query: 'paragraphs' })).coverage.retrieval, 'postgresql_full_text');
  assert.equal((await store.processEmbeddings()).indexed, 1);
  const recalled = await store.search(clientB, { query });
  assert.deepEqual(statements(recalled), [statement]);
  assert.equal(recalled.coverage.retrieval, 'postgresql_hybrid');
  assert.equal(recalled.memories[0].origin, 'user_explicit');
  assert.equal(recalled.memories[0].evidence[0].quote, statement);
  assert.equal(recalled.memories[0].evidence[0].author_role, 'user');
  const beforeBrowse = embeddings.calls.length;
  assert.deepEqual(statements(await store.search(clientB, {})), [statement]);
  assert.equal(embeddings.calls.length, beforeBrowse, 'Blank browsing should not call an embedding provider.');
});

test('lexical and vector ranks merge once per memory before applying the requested limit', async () => {
  const { clientA, clientB } = principals();
  const both = 'Writing style uses brief paragraphs.';
  const semantic = 'Keep prose compact.';
  const lexical = 'Writing style references an unrelated manual.';
  const query = 'writing style';
  const embeddings = syntheticEmbeddings({ [both]: [0.8, 0.6, 0, 0], [semantic]: [1, 0, 0, 0], [lexical]: [0, 0, 1, 0], [query]: [1, 0, 0, 0] });
  const store = createStore(fixture.db, { embeddings });
  for (const statement of [both, semantic, lexical]) await store.capture(clientA, captureInput(statement));
  await store.processEmbeddings();
  const all = await store.search(clientB, { query, limit: 10 });
  assert.deepEqual(statements(all), [both, semantic, lexical].sort());
  assert.equal(all.memories[0].statement, both, 'A result present in both ranked paths receives both contributions.');
  assert.equal(new Set(all.memories.map(memory => memory.id)).size, 3);
  const limited = await store.search(clientB, { query, limit: 1 });
  assert.deepEqual(statements(limited), [both]);
});

test('owner, project, read permission, subject, source, and status filters constrain both retrieval paths', async () => {
  const { profile, clientA, clientB } = principals();
  const other = principals();
  const allowed = 'Orchid belongs to Alex in launch.';
  const statementsToIndex = [allowed, 'Orchid belongs to Alex in confidential.', 'Orchid belongs to Blair in launch.', 'Orchid was captured by a different client.', 'Orchid may belong to Alex.', 'Orchid belongs to another owner.'];
  const embeddings = syntheticEmbeddings(Object.fromEntries([...statementsToIndex, 'orchid', 'garden context'].map(text => [text, [1, 0, 0, 0]])));
  const store = createStore(fixture.db, { embeddings });
  await store.capture(clientA, captureInput(allowed, { subject: 'Alex' }));
  await store.capture(clientA, captureInput(statementsToIndex[1], { subject: 'Alex', project_id: 'confidential' }));
  await store.capture(clientA, captureInput(statementsToIndex[2], { subject: 'Blair' }));
  await store.capture({ ...clientA, clientId: 'client-c' }, captureInput(statementsToIndex[3], { subject: 'Alex' }));
  await store.capture(clientA, captureInput(statementsToIndex[4], { subject: 'Alex' }, { origin: 'inferred' }));
  await store.capture(other.clientA, captureInput(statementsToIndex[5], { subject: 'Alex' }));
  await store.processEmbeddings();
  const scoped = { ...clientB, projects: ['launch'] };
  for (const query of ['orchid', 'garden context']) {
    const result = await store.search(scoped, { query, subject: 'Alex', source: 'client-a', project_id: 'launch', status: 'active' });
    assert.deepEqual(statements(result), [allowed]);
    assert.equal(result.coverage.retrieval, 'postgresql_hybrid');
    const inferred = await store.search(scoped, { query, subject: 'Alex', source: 'client-a', status: 'candidate' });
    assert.deepEqual(statements(inferred), [statementsToIndex[4]]);
    assert.equal(inferred.memories[0].origin, 'inferred');
    assert.equal(inferred.memories[0].evidence[0].quote, statementsToIndex[4]);
    assert.equal(inferred.memories[0].evidence[0].origin, 'user_explicit', 'The source role remains separate from the interpretation.');
  }
  const beforeDenied = embeddings.calls.length;
  await assert.rejects(store.search({ ...profile, permissions: ['capture'] }, { query: 'garden context' }), hasError(403, 'permission_denied'));
  await assert.rejects(store.search(scoped, { query: 'garden context', project_id: 'confidential' }), hasError(403, 'scope_denied'));
  assert.equal(embeddings.calls.length, beforeDenied, 'Denied requests should fail before sending a query to a provider.');
});

test('provider failure falls back to current lexical results and reports degraded retrieval', async () => {
  const { clientA, clientB } = principals();
  const statement = 'The deadline is October 27.';
  const embeddings = syntheticEmbeddings();
  const store = createStore(fixture.db, { embeddings });
  await store.capture(clientA, captureInput(statement));
  await store.processEmbeddings();
  embeddings.fail = true;
  const result = await store.search(clientB, { query: 'deadline' });
  assert.deepEqual(statements(result), [statement]);
  assert.equal(result.coverage.retrieval, 'postgresql_full_text');
  assert.equal(result.coverage.semantic_search, 'provider_unavailable');
});

test('configured embeddings remain optional when PostgreSQL has no pgvector extension', async () => {
  const database = await createTestDatabase();
  try {
    const { clientA, clientB } = principals();
    const embeddings = syntheticEmbeddings();
    const store = createStore(database.db, { embeddings });
    const statement = 'The deadline is October 27.';
    await store.capture(clientA, captureInput(statement));
    const result = await store.search(clientB, { query: 'deadline' });
    assert.deepEqual(statements(result), [statement]);
    assert.equal(result.coverage.retrieval, 'postgresql_full_text');
    assert.equal(result.coverage.semantic_search, 'pgvector_unavailable');
    assert.equal((await store.processEmbeddings()).indexed, 0);
    assert.equal(embeddings.calls.length, 0);
  } finally { await database.close(); }
});

test('changing endpoint, model, or dimensions makes old vector spaces ineligible until rebuilt', async () => {
  const { clientA, clientB } = principals();
  const statement = 'Use brief paragraphs.';
  const query = 'writing style';
  const original = syntheticEmbeddings({ [statement]: [1, 0, 0, 0], [query]: [1, 0, 0, 0] });
  const store = createStore(fixture.db, { embeddings: original });
  await store.capture(clientA, captureInput(statement));
  await store.processEmbeddings();
  assert.deepEqual(statements(await store.search(clientB, { query })), [statement]);
  for (const config of [
    { baseUrl: 'http://second-synthetic-endpoint.invalid/v1/' },
    { modelId: 'synthetic-context-v2' },
    { dimensions: 3 },
  ]) {
    const vector = config.dimensions === 3 ? [1, 0, 0] : [1, 0, 0, 0];
    const next = createStore(fixture.db, { embeddings: syntheticEmbeddings({ [statement]: vector, [query]: vector }, config) });
    assert.deepEqual(statements(await next.search(clientB, { query })), [], 'An old coordinate space must never be compared to a changed provider.');
    assert.equal((await next.processEmbeddings()).indexed, 1);
    assert.deepEqual(statements(await next.search(clientB, { query })), [statement]);
  }
});

test('correction and deletion immediately invalidate vectors and fresh recall returns only the corrected deadline', async () => {
  const { profile, clientA, clientB } = principals();
  const oldDeadline = 'The launch deadline is October 20, 2026.';
  const corrected = 'The launch deadline is October 27, 2026.';
  const preference = 'Use short paragraphs in my writing.';
  const query = 'personal working context';
  const embeddings = syntheticEmbeddings(Object.fromEntries([oldDeadline, corrected, preference, query].map(text => [text, [1, 0, 0, 0]])));
  const store = createStore(fixture.db, { embeddings });
  const deadline = await store.capture(clientA, captureInput(oldDeadline));
  const writing = await store.capture(clientA, captureInput(preference, {}, { kind: 'preference' }));
  await store.processEmbeddings();
  assert.deepEqual(statements(await store.search(clientB, { query })), [oldDeadline, preference].sort());
  await store.correct(profile, deadline.memory_ids[0], { statement: corrected, expected_revision: 1 });
  await store.remove(profile, writing.memory_ids[0], { expected_revision: 1 });
  assert.deepEqual(await storedVectors(), [], 'Stale embeddings must be removed synchronously, before reindexing.');
  for (const client of [clientA, clientB]) {
    assert.deepEqual(statements(await store.search(client, { query })), []);
    assert.deepEqual(statements(await store.search(client, { query: 'deadline' })), [corrected]);
    assert.deepEqual(statements(await store.search(client, {})), [corrected]);
  }
  assert.equal((await store.processEmbeddings()).indexed, 1);
  for (const client of [clientA, clientB]) {
    const fresh = await store.search(client, { query });
    assert.deepEqual(statements(fresh), [corrected]);
    assert.equal(fresh.memories[0].revision, 2);
    assert.equal(fresh.memories[0].authoritative, true);
    assert.equal(fresh.memories[0].evidence[0].quote, corrected);
  }
  const bundle = await store.export(profile);
  assert.equal(JSON.stringify(bundle).includes(preference), false);
  assert.equal((await storedVectors())[0].revision, 2);
});

test('superseded exact duplicates lose vectors and cannot reappear through semantic search', async () => {
  const { profile, clientA, clientB } = principals();
  const original = 'The review deadline is October 20.';
  const corrected = 'The review deadline is October 27.';
  const query = 'delivery timing';
  const embeddings = syntheticEmbeddings(Object.fromEntries([original, corrected, query].map(text => [text, [1, 0, 0, 0]])));
  const store = createStore(fixture.db, { embeddings });
  const first = await store.capture(clientA, captureInput(original));
  const duplicate = await store.capture({ ...clientB, permissions: ['capture', 'read'] }, captureInput(original, {}, { kind: 'project_state' }));
  await store.processEmbeddings();
  assert.equal((await storedVectors()).length, 2);
  await store.correct(profile, first.memory_ids[0], { statement: corrected, expected_revision: 1 });
  assert.equal((await store.detail(profile, duplicate.memory_ids[0])).memory.status, 'superseded');
  assert.deepEqual(await storedVectors(), []);
  await store.processEmbeddings();
  assert.deepEqual(statements(await store.search(clientB, { query })), [corrected]);
  assert.deepEqual(await storedVectors(duplicate.memory_ids[0]), []);
});

test('in-flight embedding output cannot restore a deleted memory or an older revision', async () => {
  const { profile, clientA } = principals();
  const oldDeadline = 'The release deadline is October 20.';
  const corrected = 'The release deadline is October 27.';
  const preference = 'Use compact release notes.';
  const query = 'personal working context';
  const embeddings = syntheticEmbeddings(Object.fromEntries([oldDeadline, corrected, preference, query].map(text => [text, [1, 0, 0, 0]])));
  const store = createStore(fixture.db, { embeddings });
  const deadline = await store.capture(clientA, captureInput(oldDeadline));
  const writing = await store.capture(clientA, captureInput(preference));
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  embeddings.beforeEmbed = async () => { signalStarted(); await pending; };
  const processing = store.processEmbeddings();
  await started;
  try {
    await store.correct(profile, deadline.memory_ids[0], { statement: corrected, expected_revision: 1 });
    await store.remove(profile, writing.memory_ids[0], { expected_revision: 1 });
  } finally { release(); }
  const result = await processing;
  assert.equal(result.indexed, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(await storedVectors(), []);
  await store.processEmbeddings();
  assert.deepEqual(statements(await store.search(profile, { query })), [corrected]);
});

test('portable bundles exclude embeddings and rebuild semantic retrieval from preserved evidence after import', async () => {
  const { profile, clientA } = principals();
  const statement = 'Use concise paragraphs.';
  const query = 'writing style';
  const embeddings = syntheticEmbeddings({ [statement]: [1, 0, 0, 0], [query]: [1, 0, 0, 0] });
  const store = createStore(fixture.db, { embeddings });
  await store.capture(clientA, captureInput(statement));
  await store.processEmbeddings();
  const bundle = await store.export(profile);
  assert.equal('embeddings' in bundle, false);
  assert.equal(JSON.stringify(bundle).includes('synthetic-context-v1'), false);
  const destination = await createTestDatabase({ vector: true });
  try {
    const imported = createStore(destination.db, { embeddings });
    const importedProfile = principals().profile;
    await imported.import(importedProfile, bundle);
    assert.deepEqual(statements(await imported.search(importedProfile, { query })), []);
    assert.deepEqual(statements(await imported.search(importedProfile, { query: 'paragraphs' })), [statement]);
    assert.equal((await imported.processEmbeddings()).indexed, 1);
    const fresh = await imported.search(importedProfile, { query });
    assert.deepEqual(statements(fresh), [statement]);
    assert.equal(fresh.memories[0].evidence[0].quote, statement);
  } finally { await destination.close(); }
});

test('exact pgvector retrieval supports configured 4096 dimensions without selecting an incompatible ANN index', async () => {
  const { clientA, clientB } = principals();
  const statement = 'Use short paragraphs.';
  const query = 'writing style';
  const vector = Array<number>(4096).fill(0); vector[0] = 1;
  const embeddings = syntheticEmbeddings({ [statement]: vector, [query]: vector }, { dimensions: 4096 });
  const store = createStore(fixture.db, { embeddings });
  await store.capture(clientA, captureInput(statement));
  assert.equal((await store.processEmbeddings()).indexed, 1);
  assert.deepEqual(statements(await store.search(clientB, { query })), [statement]);
  const stored = await fixture.db.query('SELECT vector_dims(embedding) AS dimensions FROM tk_embeddings');
  assert.equal(stored.rows[0].dimensions, 4096);
  const indexes = await fixture.db.query("SELECT indexdef FROM pg_indexes WHERE tablename='tk_embeddings'");
  assert.equal(indexes.rows.some(row => /USING (?:hnsw|ivfflat)/i.test(row.indexdef)), false);
});

test('float32 extremes are normalized safely and nonfinite legacy cosine scores cannot enter semantic recall', async () => {
  const { clientA, clientB } = principals();
  const statement = 'Use short paragraphs.';
  const query = 'writing style';
  for (const magnitude of [1e20, 1e-40]) {
    const vector = [magnitude, magnitude, 0, 0];
    const embeddings = syntheticEmbeddings({ [statement]: vector, [query]: vector }, { modelId: `synthetic-scale-${magnitude}` });
    const store = createStore(fixture.db, { embeddings });
    if (!(await storedVectors()).length) await store.capture(clientA, captureInput(statement));
    await store.processEmbeddings();
    assert.deepEqual(statements(await store.search(clientB, { query })), [statement]);
    const distance = (await fixture.db.query('SELECT embedding <=> embedding AS distance FROM tk_embeddings')).rows[0].distance;
    assert.ok(Number.isFinite(Number(distance)) && Math.abs(Number(distance)) < 0.00001);
    await fixture.db.query("UPDATE tk_embeddings SET embedding='[0,0,0,0]'::vector");
    assert.deepEqual(statements(await store.search(clientB, { query })), [], 'PostgreSQL treats NaN as greater than finite values; reject it explicitly.');
    assert.deepEqual(statements(await store.search(clientB, { query: 'paragraphs' })), [statement]);
  }
});

test('invalid provider geometry fails safely without storing vectors or disabling full-text recall', async () => {
  const { clientA, clientB } = principals();
  const statement = 'Use short paragraphs.';
  await createStore(fixture.db).capture(clientA, captureInput(statement));
  for (const [name, vector] of Object.entries({ zero: [0, 0, 0, 0], nonfinite: [NaN, 1, 0, 0], overflow: [1e100, 1, 0, 0], underflow: [1e-100, 0, 0, 0], dimensions: [1, 0, 0] })) {
    const embeddings = syntheticEmbeddings({ [statement]: vector, paragraphs: vector }, { modelId: `synthetic-invalid-${name}` });
    const store = createStore(fixture.db, { embeddings });
    const processed = await store.processEmbeddings();
    assert.equal(processed.status, 'provider_failed');
    assert.equal(processed.indexed, 0);
    assert.deepEqual(await storedVectors(), []);
    const result = await store.search(clientB, { query: 'paragraphs' });
    assert.deepEqual(statements(result), [statement]);
    assert.equal(result.coverage.semantic_search, 'provider_unavailable');
  }
});
