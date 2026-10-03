import assert from 'node:assert/strict';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from '../tests/helpers.ts';

// This reproducible walkthrough uses synthetic entries and real PostgreSQL in
// WASM. It does not invoke a model, exercise a browser, or represent independent
// third-party chatbot integrations. HTTP/MCP transport tests are separate.
console.log('Threadkeeper: synthetic memory lifecycle demonstration');
console.log('Real PostgreSQL via PGlite. Explicit captures. No model inference or browser UI.');

const sourceDatabase = await createTestDatabase();
const destinationDatabase = await createTestDatabase();
try {
  const store = createStore(sourceDatabase.db);
  const profile: Auth = { ownerId: 'synthetic-demo-owner', clientId: 'profile', permissions: ['read', 'capture', 'correct', 'delete', 'export', 'import'], projects: null };
  const clientA: Auth = { ...profile, clientId: 'synthetic-client-a', permissions: ['read', 'capture'] };
  const clientB: Auth = { ...profile, clientId: 'synthetic-client-b', permissions: ['read'] };
  const originalDeadline = 'The launch deadline is October 20, 2026.';
  const correctedDeadline = 'The launch deadline is October 27, 2026.';
  const preference = 'Use short paragraphs in my writing.';
  function capture(statement: string, name: string, kind: 'fact' | 'preference') {
    return store.capture(clientA, {
      idempotency_key: `demo:${name}`, project_id: 'launch', subject: 'self',
      events: [{ id: `demo:${name}`, text: statement, author_role: 'user', origin: 'user_explicit', occurred_at: '2026-10-01T12:00:00Z' }],
      explicit_memories: [{ statement, kind, source_event_id: `demo:${name}`, quote: statement, origin: 'user_explicit' }],
    });
  }

  const deadline = await capture(originalDeadline, 'deadline', 'fact');
  const writing = await capture(preference, 'writing-preference', 'preference');
  console.log('1. Client A captured a deadline and a writing preference in separate source events.');

  const first = await store.search(clientB, {});
  assert.deepEqual(first.memories.map(memory => memory.statement).sort(), [originalDeadline, preference].sort());
  assert.ok(first.memories.every(memory => memory.evidence.length === 1 && memory.evidence[0].client_id === clientA.clientId));
  console.log('2. Client B recalled both from the shared store without receiving Client A’s transcript:');
  for (const memory of first.memories) console.log(`   ${memory.statement} [${memory.origin}; revision ${memory.revision}]`);

  await store.correct(profile, deadline.memory_ids[0], { statement: correctedDeadline, expected_revision: 1 });
  await store.remove(profile, writing.memory_ids[0], { expected_revision: 1 });
  console.log('3. The owner profile principal changed the deadline and deleted the preference.');

  for (const client of [clientA, clientB]) {
    const fresh = await store.search(client, {});
    assert.deepEqual(fresh.memories.map(memory => memory.statement), [correctedDeadline]);
    assert.ok(fresh.snapshot_version > first.snapshot_version);
  }
  console.log(`4. Fresh recall from both principals contains only: ${correctedDeadline}`);

  const bundle = await store.export(profile);
  assert.equal(JSON.stringify(bundle).includes(preference), false);
  const importedStore = createStore(destinationDatabase.db);
  const importedProfile = { ...profile, ownerId: 'synthetic-import-owner' };
  const imported = await importedStore.import(importedProfile, bundle);
  assert.equal(imported.imported_memories, 1);
  assert.deepEqual((await importedStore.search(importedProfile, {})).memories.map(memory => memory.statement), [correctedDeadline]);
  const afterImport = await importedStore.export(importedProfile);
  assert.deepEqual(afterImport.sources, bundle.sources);
  assert.deepEqual(afterImport.evidence, bundle.evidence);
  assert.deepEqual(afterImport.revisions, bundle.revisions);
  console.log('Export/import into a fresh database preserved the remaining evidence, corrections, and deletion tombstones.');
  console.log('PASS: local database lifecycle assertions. UI, hosted inference, and external client demonstrations still require separate execution.');
} finally {
  await sourceDatabase.close();
  await destinationDatabase.close();
}
