import assert from 'node:assert/strict';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from '../tests/helpers.ts';
import { syntheticEmbeddings } from '../tests/hybrid-fixtures.ts';

// This reproducible walkthrough uses synthetic entries and real PostgreSQL in
// WASM by default. It does not invoke a model, exercise a browser, or represent
// independent third-party chatbot integrations. HTTP/MCP transport tests are separate.
async function demonstrate(hybrid: boolean) {
  console.log(`Threadkeeper: synthetic ${hybrid ? 'hybrid' : 'full-text'} memory lifecycle demonstration`);
  const sourceDatabase = await createTestDatabase({ vector: hybrid });
  const destinationDatabase = await createTestDatabase({ vector: hybrid });
  console.log(`PostgreSQL via ${sourceDatabase.backend === 'native' ? 'native server' : 'PGlite WASM'}. Explicit captures. No model inference or browser UI.`);
  try {
    const profile: Auth = { ownerId: 'synthetic-demo-owner', clientId: 'profile', permissions: ['read', 'capture', 'correct', 'delete', 'export', 'import'], projects: null };
    const clientA: Auth = { ...profile, clientId: 'synthetic-client-a', permissions: ['read', 'capture'] };
    const clientB: Auth = { ...profile, clientId: 'synthetic-client-b', permissions: ['read'] };
    const originalDeadline = 'The launch deadline is October 20, 2026.';
    const correctedDeadline = 'The launch deadline is October 27, 2026.';
    const preference = 'Use short paragraphs in my writing.';
    const reported = 'An agent reported that the synthetic draft is ready.';
    const inference = 'Inferred from conversation: morning drafting may work well.';
    const proposal = 'An assistant suggested adding a synthetic weekly outline.';
    const recallQuery = hybrid ? 'personal working context' : '';
    const embeddings = hybrid ? syntheticEmbeddings(Object.fromEntries(
      [originalDeadline, correctedDeadline, preference, reported, inference, proposal, recallQuery].map(text => [text, [1, 0, 0, 0]]),
    )) : undefined;
    const store = createStore(sourceDatabase.db, { embeddings });
    function capture(statement: string, name: string, kind: 'fact' | 'preference') {
      return store.capture(clientA, {
        idempotency_key: `demo:${name}`, project_id: 'launch', subject: 'self',
        events: [{ id: `demo:${name}`, text: statement, author_role: 'user', origin: 'user_explicit', occurred_at: '2026-10-01T12:00:00Z' }],
        explicit_memories: [{ statement, kind, source_event_id: `demo:${name}`, quote: statement, origin: 'user_explicit' }],
      });
    }

    const deadline = await capture(originalDeadline, 'deadline', 'fact');
    const writing = await capture(preference, 'writing-preference', 'preference');
    const interpretations = [];
    for (const [origin, statement] of [['agent_reported', reported], ['inferred', inference], ['assistant_proposed', proposal]] as const) {
      interpretations.push(await store.capture(clientA, {
        idempotency_key: `demo:${origin}`, project_id: 'launch', subject: 'self',
        events: [{ id: `demo:${origin}`, text: statement, author_role: 'assistant', origin }],
        explicit_memories: [{ statement, kind: 'project_state', source_event_id: `demo:${origin}`, quote: statement, origin }],
      }));
    }
    console.log('1. Client A captured statements, a report, an inference and an assistant contribution as separate source events.');
    if (hybrid) {
      assert.equal((await store.processEmbeddings()).indexed, 5);
      console.log('   Indexed deterministic synthetic vectors with pgvector; no provider credentials or network calls.');
    }

    const first = await store.search(clientB, { query: recallQuery });
    assert.equal(first.coverage.retrieval, hybrid ? 'postgresql_hybrid' : 'postgresql_full_text');
    assert.deepEqual(first.memories.map(memory => memory.statement).sort(), [originalDeadline, preference, reported, inference, proposal].sort());
    assert.deepEqual(first.memories.map(memory => memory.origin).sort(), ['user_explicit', 'user_explicit', 'agent_reported', 'inferred', 'assistant_proposed'].sort());
    assert(first.memories.every(memory => memory.status === 'active' && !memory.authoritative));
    assert.ok(first.memories.every(memory => memory.evidence.length === 1 && memory.evidence[0].client_id === clientA.clientId));
    console.log('2. Client B recalled every current memory immediately with its source label:');
    for (const memory of first.memories) console.log(`   ${memory.statement} [${memory.origin}; revision ${memory.revision}]`);

    const corrected = await store.correct(profile, deadline.memory_ids[0], { statement: correctedDeadline, expected_revision: 1 });
    assert.equal(corrected.memory.origin, 'user_confirmed');
    await store.remove(profile, writing.memory_ids[0], { expected_revision: 1, preview_hash: (await store.previewRemoval(profile, writing.memory_ids[0])).preview_hash });
    for (const interpretation of interpretations) {
      const id = interpretation.memory_ids[0];
      await store.remove(profile, id, { expected_revision: 1, preview_hash: (await store.previewRemoval(profile, id)).preview_hash });
    }
    console.log('3. The owner profile principal changed the deadline and deleted the preference.');
    if (hybrid) {
      assert.equal((await sourceDatabase.db.query('SELECT count(*)::int AS count FROM tk_embeddings')).rows[0].count, 0);
      assert.deepEqual((await store.search(clientB, { query: 'deadline' })).memories.map(memory => memory.statement), [correctedDeadline]);
      assert.equal((await store.processEmbeddings()).indexed, 1);
      console.log('   Removed outdated/deleted vectors immediately; full-text recalled the correction before its vector rebuild.');
    }

    for (const client of [clientA, clientB]) {
      const fresh = await store.search(client, { query: recallQuery });
      assert.deepEqual(fresh.memories.map(memory => memory.statement), [correctedDeadline]);
      assert.ok(fresh.snapshot_version > first.snapshot_version);
    }
    console.log(`4. Fresh recall from both principals contains only: ${correctedDeadline}`);

    const bundle = await store.export(profile);
    assert.equal(JSON.stringify(bundle).includes(preference), false);
    assert.equal('embeddings' in bundle, false);
    const importedStore = createStore(destinationDatabase.db, { embeddings });
    const importedProfile = { ...profile, ownerId: 'synthetic-import-owner' };
    const imported = await importedStore.import(importedProfile, bundle);
    assert.equal(imported.imported_memories, 1);
    if (hybrid) assert.equal((await importedStore.processEmbeddings()).indexed, 1);
    assert.deepEqual((await importedStore.search(importedProfile, { query: recallQuery })).memories.map(memory => memory.statement), [correctedDeadline]);
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
}

await demonstrate(false);
await demonstrate(true);
