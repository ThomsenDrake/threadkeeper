import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createStore, DomainError, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { syntheticEmbeddings } from './hybrid-fixtures.ts';
import type { CaptureInput } from '../packages/contracts/src/index.ts';

async function forget(store: ReturnType<typeof createStore>, auth: Auth, id: string, expectedRevision: number) {
  const preview = await store.previewRemoval(auth, id);
  return store.remove(auth, id, { expected_revision: expectedRevision, preview_hash: preview.preview_hash });
}

const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['read', 'capture', 'correct', 'delete', 'export', 'import', 'review'], projects: null });
const error = (status: number, code: string) => (cause: unknown) => cause instanceof DomainError && cause.status === status && cause.code === code;
const capture = (statement: string, options: Partial<CaptureInput> = {}, inferred = false): CaptureInput => ({
  idempotency_key: randomUUID(), project_id: null, subject: 'self',
  events: [{ id: randomUUID(), text: statement, author_role: 'user', origin: 'user_explicit' }],
  ...options,
  explicit_memories: [{ statement, kind: 'fact', source_event_id: '', quote: statement, origin: inferred ? 'inferred' : 'user_explicit' }],
});
async function save(store: ReturnType<typeof createStore>, auth: Auth, statement: string, options: Partial<CaptureInput> = {}, inferred = false) {
  const input = capture(statement, options, inferred);
  input.explicit_memories![0].source_event_id = input.events[0].id;
  return store.capture(auth, input);
}

test('owner pages reach a realistic mixed collection with stable ties, truthful totals and scoped filters; older records remain editable and forgettable', async t => {
  const db = await createTestDatabase({ vector: true }); t.after(() => db.close());
  const store = createStore(db.db); const auth = owner();
  const expected: { id: string; project: string | null; subject: string; source: string; status: string }[] = [];
  for (let index = 0; index < 144; index++) {
    const project = index % 3 === 0 ? null : index % 3 === 1 ? 'atlas' : 'private';
    const subject = index % 2 ? 'Alex' : 'self'; const source = index % 4 ? 'profile' : 'synthetic-client';
    const inferred = index % 12 === 0;
    const result = await save(store, { ...auth, clientId: source }, `Synthetic archive item ${String(index).padStart(3, '0')} uses common context.`, { project_id: project, subject }, inferred);
    expected.push({ id: result.memory_ids[0], project, subject, source, status: inferred ? 'candidate' : 'active' });
  }
  await save(store, owner(), 'Synthetic archive item belonging to another owner.');
  // Equal timestamps specifically exercise the ID tie-breaker across page boundaries.
  await db.db.query('UPDATE tk_memories SET updated_at=$1 WHERE owner_id=$2', ['2026-10-01T00:00:00Z', auth.ownerId]);
  const first = await store.list(auth, { limit: 50 });
  assert.equal(first.total_count, 144); assert.equal(first.next_offset, 50);
  const second = await store.list(auth, { limit: 50, offset: first.next_offset, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version });
  const third = await store.list(auth, { limit: 50, offset: second.next_offset, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version });
  assert.equal(third.next_offset, null); assert.equal(third.memories.length, 44);
  const ids = [...first.memories, ...second.memories, ...third.memories].map(memory => memory.id);
  assert.equal(new Set(ids).size, 144); assert.deepEqual(ids, expected.map(item => item.id).sort());
  assert.equal((await store.list(auth, { offset: 100_000 })).total_count, 144);
  assert.deepEqual((await store.list(auth, { offset: 100_000 })).memories, []);
  for (const filters of [
    { project_id: 'atlas' }, { project_id: null }, { subject: 'Alex' }, { source: 'synthetic-client' }, { status: 'candidate' },
    { query: 'common context', project_id: 'atlas', subject: 'Alex', source: 'profile', status: 'active' },
  ]) {
    const matches = expected.filter(item => (filters.project_id === undefined || item.project === filters.project_id)
      && (!filters.subject || item.subject === filters.subject) && (!filters.source || item.source === filters.source) && (!filters.status || item.status === filters.status));
    let offset: number | null = 0; const found: string[] = [];
    while (offset !== null) {
      const page = await store.list(auth, { ...filters, limit: 7, offset });
      assert.equal(page.total_count, matches.length); found.push(...page.memories.map(memory => memory.id)); offset = page.next_offset!;
    }
    assert.deepEqual(found.sort(), matches.map(item => item.id).sort());
  }
  const scoped = { ...auth, projects: ['atlas'] };
  assert.equal((await store.list(scoped, { limit: 100 })).total_count, 96);
  await assert.rejects(store.list(scoped, { project_id: 'private', offset: 50 }), error(403, 'scope_denied'));
  await assert.rejects(store.list({ ...auth, permissions: [] }, { offset: 100 }), error(403, 'permission_denied'));
  const old = third.memories.find(memory => memory.status === 'active')!;
  const detail = await store.detail(auth, old.id); assert.equal(detail.sources.length, 1);
  await store.correct(auth, old.id, { statement: 'Synthetic older-page corrected context.', expected_revision: old.revision });
  await assert.rejects(store.list(auth, { offset: 50, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version }), error(409, 'memory_list_changed'));
  const current = await store.detail(auth, old.id); assert.equal(current.memory.revision, 2); assert.equal(current.sources.length, 2);
  await forget(store, auth, old.id, 2);
  assert.equal((await store.list(auth, { query: 'older-page corrected' })).total_count, 0);
  assert.equal((await store.list(auth, {})).total_count, 143);
  assert.equal(JSON.stringify(await store.export(auth)).includes('older-page corrected'), false);
  for (const filters of [{ offset: -1 }, { offset: 100_001 }, { offset: 'x' }, { limit: 101 }, { ranking_version: 'bad' }, { snapshot_version: -1 }, { query: 'x'.repeat(4001) }, { cursor: 'unknown' }]) {
    await assert.rejects(store.list(auth, filters), error(400, 'invalid_input'));
  }
  await assert.rejects(store.search(auth, { offset: 1 }), error(400, 'invalid_input'));
  assert.equal((await store.search(auth, { limit: 100 })).memories.length, 100, 'Client recall retains its bounded contract.');
});

test('hybrid owner pages rank all matches beyond recall candidate limits and reject changed indexing/provider order', async t => {
  const db = await createTestDatabase({ vector: true }); t.after(() => db.close());
  const auth = owner(); const query = 'synthetic semantic-only query';
  const vectors: Record<string, number[]> = { [query]: [1, 0, 0, 0] };
  for (let index = 0; index < 125; index++) vectors[`Synthetic archive vector ${index}.`] = [1, 0, 0, 0];
  const embeddings = syntheticEmbeddings(vectors); const store = createStore(db.db, { embeddings });
  for (let index = 0; index < 125; index++) await save(store, auth, `Synthetic archive vector ${index}.`);
  while ((await store.processEmbeddings()).indexed > 0) { /* bounded batches */ }
  const first = await store.list(auth, { query, limit: 10 }); assert.equal(first.total_count, 125);
  const all: string[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const page = await store.list(auth, { query, limit: 10, offset, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version });
    all.push(...page.memories.map(memory => memory.id)); offset = page.next_offset!;
  }
  assert.equal(all.length, 125); assert.equal(new Set(all).size, 125);
  assert.equal((await store.search(auth, { query, limit: 10 })).memories.length, 10);
  const memoryId = all.at(-1)!;
  await db.db.query('DELETE FROM tk_embeddings WHERE memory_id=$1', [memoryId]);
  await assert.rejects(store.list(auth, { query, offset: 10, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version }), error(409, 'memory_list_changed'));
  await store.processEmbeddings();
  assert.equal((await store.list(auth, { query, offset: 10, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version })).memories.length, 20);
  embeddings.fail = true;
  await assert.rejects(store.list(auth, { query, offset: 10, snapshot_version: first.snapshot_version, ranking_version: first.ranking_version }), error(409, 'memory_list_changed'));
  const fallback = await store.list(auth, { query }); assert.equal(fallback.total_count, 0); assert.equal(fallback.coverage.retrieval, 'postgresql_full_text');
});

test('import counts new/existing sources and memories, explains deletion/evidence exclusions and rolls back conflicts atomically', async t => {
  const db = await createTestDatabase({ vector: true }); t.after(() => db.close());
  const sourceDb = await createTestDatabase({ vector: true }); t.after(() => sourceDb.close());
  const sourceStore = createStore(sourceDb.db); const store = createStore(db.db); const auth = owner();
  const first = await save(sourceStore, auth, 'Synthetic retained import record.');
  const forgotten = await save(sourceStore, auth, 'Synthetic forgotten import record.');
  const backup = await sourceStore.export(auth);
  const destination = owner();
  const fresh = await store.import(destination, backup);
  assert.equal(fresh.imported_sources, 2); assert.equal(fresh.imported_memories, 2); assert.equal(fresh.existing_sources, 0); assert.equal(fresh.skipped_memories, 0);
  const identical = await store.import(destination, backup);
  assert.equal(identical.imported_sources, 0); assert.equal(identical.imported_memories, 0); assert.equal(identical.existing_sources, 2); assert.equal(identical.existing_memories, 2);
  assert.equal((await db.db.query('SELECT id FROM tk_clients WHERE user_id=$1', [destination.ownerId])).rows.length, 0);
  await forget(store, destination, forgotten.memory_ids[0], 1);
  const older = await store.import(destination, backup);
  assert.equal(older.imported_memories, 0); assert.equal(older.existing_memories, 1); assert.equal(older.skipped_sources, 1); assert.equal(older.skipped_memories, 1);
  assert.equal(older.tombstone_excluded_sources, 1); assert.equal(older.evidence_excluded_memories, 1); assert.equal(older.tombstone_excluded_memories, 0);
  // Different retained evidence cannot reintroduce a memory blocked by its scoped content tombstone.
  const reinterpretation = structuredClone(backup);
  reinterpretation.sources = reinterpretation.sources.filter(source => reinterpretation.evidence.some(e => e.memory_id === forgotten.memory_ids[0] && e.source_id === source.id));
  reinterpretation.memories = reinterpretation.memories.filter(memory => memory.id === forgotten.memory_ids[0]);
  reinterpretation.revisions = reinterpretation.revisions.filter(revision => revision.memory_id === forgotten.memory_ids[0]);
  reinterpretation.evidence = reinterpretation.evidence.filter(e => e.memory_id === forgotten.memory_ids[0]);
  const source = reinterpretation.sources[0]; const oldSourceId = source.id;
  source.id = randomUUID(); source.event_id = randomUUID(); source.text = 'Synthetic safe evidence for an excluded interpretation.'; source.checksum = createHash('sha256').update(source.text).digest('hex');
  for (const evidence of reinterpretation.evidence) if (evidence.source_id === oldSourceId) { evidence.source_id = source.id; evidence.quote = source.text; }
  const excluded = await store.import(destination, reinterpretation);
  assert.equal(excluded.imported_sources, 1); assert.equal(excluded.skipped_memories, 1); assert.equal(excluded.tombstone_excluded_memories, 1); assert.equal(excluded.evidence_excluded_memories, 0);
  // Confirmed current text can be innocuous while its earlier interpretation
  // matches deletion history. Distinct safe quotes/identities must not bypass it.
  const historicalOwner = owner();
  const historicalInput = capture('Synthetic forgotten import record.', {
    events: [{ id: randomUUID(), text: 'Synthetic distinct safe background evidence.', author_role: 'user', origin: 'user_explicit' }],
  }, true);
  historicalInput.explicit_memories![0].source_event_id = historicalInput.events[0].id;
  historicalInput.explicit_memories![0].quote = historicalInput.events[0].text;
  const historical = await sourceStore.capture(historicalOwner, historicalInput);
  await sourceStore.review(historicalOwner, historical.memory_ids[0], {
    action: 'confirm', expected_revision: 1, statement: 'Synthetic accepted current interpretation with safe wording.',
  });
  const historicalBundle = await sourceStore.export(historicalOwner);
  assert(historicalBundle.memories[0].authoritative);
  const hiddenHistory = await store.import(destination, historicalBundle);
  assert.equal(hiddenHistory.imported_sources, 2); assert.equal(hiddenHistory.tombstone_excluded_sources, 0);
  assert.equal(hiddenHistory.imported_memories, 0); assert.equal(hiddenHistory.skipped_memories, 1);
  assert.equal(hiddenHistory.tombstone_excluded_memories, 1); assert.equal(hiddenHistory.evidence_excluded_memories, 0);
  const repeatedHistory = await store.import(destination, historicalBundle);
  assert.equal(repeatedHistory.existing_sources, 2); assert.equal(repeatedHistory.imported_sources, 0); assert.equal(repeatedHistory.tombstone_excluded_memories, 1);
  const historyExport = await store.export(destination);
  assert.equal(JSON.stringify(historyExport).includes('Synthetic forgotten import record.'), false);
  assert(!historyExport.memories.some(memory => memory.id === historical.memory_ids[0]));
  // New rows are deliberately ordered before the conflict so rollback is substantive.
  const extraOwner = owner(); await save(sourceStore, extraOwner, 'Synthetic import row that must roll back.');
  const extra = await sourceStore.export(extraOwner); const conflict = structuredClone(backup);
  conflict.sources = [...extra.sources, ...conflict.sources]; conflict.memories = [...extra.memories, ...conflict.memories];
  conflict.revisions = [...extra.revisions, ...conflict.revisions]; conflict.evidence = [...extra.evidence, ...conflict.evidence];
  conflict.sources.find(source => source.id === backup.evidence.find(e => e.memory_id === first.memory_ids[0])!.source_id)!.occurred_at = '2026-09-01T00:00:00Z';
  const before = await store.export(destination);
  await assert.rejects(store.import(destination, conflict), error(409, 'import_source_conflict'));
  const after = await store.export(destination);
  for (const key of ['sources', 'memories', 'revisions', 'evidence', 'tombstones'] as const) assert.deepEqual(after[key], before[key]);
  assert.equal(JSON.stringify(after).includes('must roll back'), false);
  assert.equal((await store.list(destination, {})).total_count, 1);
});
