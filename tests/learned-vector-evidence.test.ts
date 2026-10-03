import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { embeddingInputFingerprint, embeddingResponseFingerprints, storedVectorFingerprint } from '../deploy/embedding-fingerprints.mjs';
import { installDirectProviderObserver, providerObservationConfigFromEnv } from '../deploy/direct-provider-observer.mjs';
import { snapshotLearnedVector, verifyLearnedVectorEvidence } from '../deploy/integration/learned-vector-evidence.ts';
import type { LearnedObservation } from '../deploy/integration/learned-support.ts';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { OpenAICompatibleEmbeddingProvider } from '../packages/providers/src/index.ts';
import { createTestDatabase } from './helpers.ts';

const baseUrl = 'http://127.0.0.1:18818/v1/';
const model = 'Qwen/Qwen3-Embedding-8B';

test('embedding fingerprints bind response indices and exact inputs with bounded float32 preprocessing', () => {
  const request = { input: ['first synthetic statement', 'second synthetic statement'], dimensions: 3 };
  const response = { data: [{ index: 1, embedding: [0, -8, 6] }, { index: 0, embedding: [3, 4, -0] }] };
  const observed = embeddingResponseFingerprints(request, response)!;
  assert.equal(observed.dimensions, 3);
  assert.deepEqual(observed.entries, [
    { index: 0, input_sha256: embeddingInputFingerprint(request.input[0]), stored_vector_sha256: storedVectorFingerprint([0.6, 0.8, 0], 3) },
    { index: 1, input_sha256: embeddingInputFingerprint(request.input[1]), stored_vector_sha256: storedVectorFingerprint([0, -0.8, 0.6], 3) },
  ]);
  assert.equal(storedVectorFingerprint([0.6, 0.8, -0], 3), storedVectorFingerprint([0.6, 0.8, 0], 3));
  assert.notEqual(storedVectorFingerprint([3, 4, 0], 3), storedVectorFingerprint([0.6, 0.8, 0], 3), 'Stored vectors must not be normalized again');
  for (const data of [
    [{ index: 0, embedding: [1, 0, 0] }],
    [{ index: 0, embedding: [1, 0, 0] }, { index: 0, embedding: [0, 1, 0] }],
    [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }],
    ...[[0, 0, 0], [Number.MAX_VALUE, 1, 0], [Number.MIN_VALUE, 1, 0], [NaN, 1, 0], [Infinity, 1, 0]].map(embedding => [{ index: 0, embedding }, { index: 1, embedding: [1, 0, 0] }]),
  ]) assert.equal(embeddingResponseFingerprints(request, { data }), undefined);
  for (const input of [[], [''], [42], ['x'.repeat(16001)], Array(65).fill('synthetic')]) {
    assert.equal(embeddingResponseFingerprints({ input }, { data: [] }), undefined);
  }
  assert.equal(embeddingResponseFingerprints({ input: ['synthetic'], dimensions: 16001 }, { data: [{ index: 0, embedding: Array(16001).fill(1) }] }), undefined);
});

test('vector fingerprints are opt-in and original fetch preserves raw responses without recording them', async () => {
  const originalFetch = globalThis.fetch;
  const input = 'Synthetic private embedding source';
  const payload = { model, data: [{ index: 0, embedding: [3, 4, 0] }], usage: { prompt_tokens: 5, total_tokens: 5 } };
  const body = JSON.stringify({ model, input: [input], dimensions: 3 });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-secret');
    assert.equal(init?.body, body);
    return new Response(JSON.stringify(payload));
  };
  try {
    assert.equal(providerObservationConfigFromEnv({ THREADKEEPER_PROVIDER_EMBEDDING_FINGERPRINTS: 'true' }).embeddingFingerprints, false);
    for (const enabled of [false, true]) {
      const observer = installDirectProviderObserver({ baseUrl, embeddingFingerprints: enabled });
      try {
        const response = await fetch(baseUrl + 'embeddings', { method: 'POST', headers: { Authorization: 'Bearer synthetic-secret' }, body });
        assert.deepEqual(await response.json(), payload);
        assert.equal(observer.records.length, 1);
        assert.equal(!!observer.records[0].embedding_fingerprints, enabled);
        const serialized = JSON.stringify(observer.records);
        for (const hidden of [input, 'synthetic-secret', 'Authorization', '[3,4,0]']) assert(!serialized.includes(hidden));
      } finally { observer.restore(); }
    }
    assert.equal(calls, 2, 'Observation must not add inference requests');
  } finally { globalThis.fetch = originalFetch; }
});

test('actual pgvector correction must match the observed corrected input and result, rejecting a copied old vector', async t => {
  const database = await createTestDatabase({ vector: true });
  t.after(() => database.close());
  const before = 'The synthetic demonstration is due October 20, 2026.';
  const after = 'The synthetic demonstration is due October 27, 2026.';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.input, [calls === 1 ? before : after]);
    return new Response(JSON.stringify({ model, data: [{ index: 0, embedding: calls === 1
      ? [3e38, 1e38, -0, 1.23456789] : [0.25, -1.333333333, 1e-20, 0] }], usage: { prompt_tokens: 8, total_tokens: 8 } }));
  };
  const observer = installDirectProviderObserver({ baseUrl, embeddingFingerprints: true });
  try {
    const embeddings = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: model, apiKey: 'synthetic-key', dimensions: 4, timeoutMs: 1000 });
    const store = createStore(database.db, { embeddings });
    const owner: Auth = { ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null };
    const receipt = await store.capture(owner, { idempotency_key: randomUUID(), project_id: 'synthetic-vector-evidence',
      events: [{ id: 'vector-source', text: before, author_role: 'user', origin: 'user_explicit' }],
      explicit_memories: [{ statement: before, quote: before, kind: 'fact', origin: 'user_explicit', source_event_id: 'vector-source' }] });
    const memoryId = receipt.memory_ids[0];
    const row = async () => (await database.db.query('SELECT memory_id,revision,provider_model,dimensions,preprocessing_version,embedding::text AS embedding FROM tk_embeddings WHERE memory_id=$1', [memoryId])).rows[0];
    assert.equal((await store.processEmbeddings()).indexed, 1);
    const initialRow = await row();
    const original = snapshotLearnedVector(initialRow, { memory_id: memoryId, revision: 1, statement: before, model, dimensions: 4 });
    await store.correct(owner, memoryId, { expected_revision: 1, statement: after });
    assert.equal((await store.processEmbeddings()).indexed, 1);
    const changedRow = await row();
    const corrected = snapshotLearnedVector(changedRow, { memory_id: memoryId, revision: 2, statement: after, model, dimensions: 4 });
    const observations: LearnedObservation[] = observer.records.map(record => ({ ...record, service: 'worker' }));
    assert.deepEqual(verifyLearnedVectorEvidence({ original, corrected }, observations), {
      original: { ordinal: 1, index: 0 }, corrected: { ordinal: 2, index: 0 }, normalized_vector_changed: true,
    });
    // Reproduce the review finding: revision/model metadata is current, but the
    // actual stored components are silently copied from the previous revision.
    await database.db.query('UPDATE tk_embeddings SET embedding=$2::vector WHERE memory_id=$1', [memoryId, initialRow.embedding]);
    const stale = snapshotLearnedVector(await row(), { memory_id: memoryId, revision: 2, statement: after, model, dimensions: 4 });
    assert.throws(() => verifyLearnedVectorEvidence({ original, corrected: stale }, observations), /does not match/);
    for (const mutate of [
      (records: typeof observations) => { records[1].embedding_fingerprints!.entries[0].input_sha256 = embeddingInputFingerprint(before); },
      (records: typeof observations) => { records[1].embedding_fingerprints!.entries[0].stored_vector_sha256 = original.stored_vector_sha256; },
      (records: typeof observations) => { records[1].service = 'api'; },
      (records: typeof observations) => { records[1].embedding_fingerprints = undefined; },
      (records: typeof observations) => { records.push(structuredClone(records[1])); },
    ]) {
      const bad = structuredClone(observations); mutate(bad);
      assert.throws(() => verifyLearnedVectorEvidence({ original, corrected }, bad));
    }
    // Equal actual provider results are valid; storage binding is not a
    // semantic promise that every text change must move the embedding.
    const equal = structuredClone(observations);
    equal[1].embedding_fingerprints!.entries[0].stored_vector_sha256 = original.stored_vector_sha256;
    assert.equal(verifyLearnedVectorEvidence({ original, corrected: stale }, equal).normalized_vector_changed, false);
    const serialized = JSON.stringify({ original, corrected, observations });
    for (const hidden of [before, after, 'synthetic-key', initialRow.embedding, changedRow.embedding]) assert(!serialized.includes(hidden));
    assert.equal(calls, 2);
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});
