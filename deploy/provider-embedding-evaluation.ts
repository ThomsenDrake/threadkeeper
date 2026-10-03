import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from '../tests/helpers.ts';
import { OpenAICompatibleEmbeddingProvider, embeddingConfigFromEnv } from '../packages/providers/src/index.ts';
import { embeddingCorpus } from './provider-evaluation-corpus.ts';

// This script is a disposable synthetic quality check, never a runtime relay.
// Live mode calls the operator's configured HTTP provider directly. Replay mode
// maps exact strings to a saved single learned batch and makes no external call.
const mode = process.argv[2] ?? '--live';
assert(['--live', '--replay'].includes(mode), 'Use --live or --replay FILE');
const recording = mode === '--replay' ? JSON.parse(await readFile(process.argv[3], 'utf8')) : undefined;
const texts = [...embeddingCorpus.documents, ...embeddingCorpus.queries.map(query => query.text)];
let relay: Server | undefined;
let databaseResource: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
try {
let configuration = embeddingConfigFromEnv();
if (recording) {
  assert.deepEqual(recording.request, { model: embeddingCorpus.model, dimensions: embeddingCorpus.dimensions, input: texts, encoding_format: 'float' });
  assert.equal(recording.response.model, embeddingCorpus.model);
  assert.equal(recording.response.data.length, texts.length);
  const rows = new Map<string, any>(texts.map((text, index) => [text, recording.response.data.find((row: any) => row.index === index)]));
  relay = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/embeddings');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size < 1_000_000); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, embeddingCorpus.model); assert.equal(body.dimensions, embeddingCorpus.dimensions);
      assert.equal(body.encoding_format, 'float');
      assert(Array.isArray(body.input));
      const data = body.input.map((text: string, index: number) => { const row = rows.get(text); assert(row); return { ...row, index }; });
      // A subset replay has no new provider usage; report original batch once.
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ model: recording.response.model, data }));
    } catch {
      response.writeHead(409, { 'Content-Type': 'application/json' }); response.end('{"error":"embedding_evaluation_request_mismatch"}');
    }
  });
  await new Promise<void>(resolve => relay!.listen(0, '127.0.0.1', resolve));
  const address = relay.address(); assert(address && typeof address === 'object');
  configuration = { baseUrl: `http://127.0.0.1:${address.port}/v1/`, modelId: embeddingCorpus.model, dimensions: embeddingCorpus.dimensions, timeoutMs: 60_000 };
}
assert(configuration, 'Configure EMBEDDING_MODEL and EMBEDDING_DIMENSIONS before live evaluation');
assert.equal(configuration.modelId, embeddingCorpus.model, 'This fixed corpus measures its explicitly selected model; no substitution');
assert.equal(configuration.dimensions, embeddingCorpus.dimensions);
const provider = new OpenAICompatibleEmbeddingProvider(configuration);
const database = databaseResource = await createTestDatabase({ vector: true });
  const start = performance.now();
  const vectors = await provider.embed(texts);
  // Rank the one observed batch in both modes. Reusing its exact vectors
  // avoids issuing unreported live requests for indexing and each query.
  const batch = new Map(texts.map((text, index) => [text, vectors.vectors[index]]));
  const store = createStore(database.db, { embeddings: {
    config: provider.config,
    async embed(inputs) {
      return { model: vectors.model, dimensions: vectors.dimensions, vectors: inputs.map(text => {
        const vector = batch.get(text); assert(vector, 'Ranking input outside the observed batch'); return vector;
      }) };
    },
  } });
  const lexical = createStore(database.db);
  const writer: Auth = { ownerId: 'synthetic-embedding-evaluation', clientId: 'synthetic-client-a', permissions: ['capture', 'read'], projects: ['synthetic-embedding-evaluation'] };
  const reader: Auth = { ...writer, clientId: 'synthetic-client-b', permissions: ['read'] };
  const ids: string[] = [];
  for (const [index, statement] of embeddingCorpus.documents.entries()) {
    const id = `synthetic-embedding-document-${index}`;
    const receipt = await store.capture(writer, { idempotency_key: id, project_id: 'synthetic-embedding-evaluation', subject: 'self',
      events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
      explicit_memories: [{ statement, kind: 'fact', source_event_id: id, quote: statement, origin: 'user_explicit' }],
    });
    ids.push(receipt.memory_ids[0]);
  }
  assert.equal((await store.processEmbeddings()).indexed, embeddingCorpus.documents.length);
  const queries: Record<string, any>[] = [];
  for (const query of embeddingCorpus.queries) {
    const filters = { query: query.text, project_id: 'synthetic-embedding-evaluation', limit: 5 };
    const hybrid = await store.search(reader, filters);
    const fullText = await lexical.search(reader, filters);
    assert.equal(hybrid.coverage.retrieval, 'postgresql_hybrid');
    const expected = ids[query.relevant];
    queries.push({ query: query.text, expected_document_index: query.relevant,
      hybrid_rank: hybrid.memories.findIndex(memory => memory.id === expected) + 1 || null,
      lexical_rank: fullText.memories.findIndex(memory => memory.id === expected) + 1 || null,
      hybrid_document_order: hybrid.memories.map(memory => ids.indexOf(memory.id)), lexical_document_order: fullText.memories.map(memory => ids.indexOf(memory.id)),
    });
  }
  console.info(JSON.stringify({ schema_version: 'threadkeeper.provider-embedding-evaluation.v1', measured_at: new Date().toISOString(),
    model: vectors.model, dimensions: vectors.dimensions, vector_count: vectors.vectors.length, database: database.backend,
    transport: recording ? 'offline_recorded_learned_vectors_over_local_http_adapter' : 'direct_operator_http_provider',
    preprocessing: 'raw statement and query text; no query instruction prefix; application float32 conversion and unit normalization',
    usage: recording?.response.usage ?? vectors.usage, original_integration_elapsed_ms: recording?.elapsed_ms,
    live_provider_request_count: recording ? 0 : 1,
    ranking_vectors: 'exact vectors reused from the single observed batch',
    queries, hybrid_recall_at_1: queries.filter(query => query.hybrid_rank === 1).length / queries.length,
    lexical_recall_at_1: queries.filter(query => query.lexical_rank === 1).length / queries.length,
    elapsed_ms: Math.round(performance.now() - start),
    limits: ['Four prelabelled queries and five documents are a small synthetic sample.', 'Replay subsets reuse one measured batch; they do not perform inference or generate new token usage.', 'Core principals and pgvector ranking are exercised; this script alone is not an HTTP/MCP or installed-host check.', 'No comparison to instruction-prefixed queries, ANN benchmark, full local GPU flow or deployment.'],
  }, null, 2));
} finally {
  const cleanup = await Promise.allSettled([
    ...(relay?.listening ? [(async () => {
      const closed = new Promise<void>((resolve, reject) => relay!.close(error => error ? reject(error) : resolve()));
      relay!.closeAllConnections(); await closed;
    })()] : []),
    ...(databaseResource ? [databaseResource.close()] : []),
  ]);
  if (cleanup.some(result => result.status === 'rejected')) throw new Error('embedding_evaluation_cleanup_failed');
}
