import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
  ProviderError,
  createEmbeddingProvider,
  embeddingConfigFromEnv,
  providerConfigFromEnv,
  type ProviderConfig,
} from '../packages/providers/src/index.ts';

type FakeRequest = { path?: string; authorization?: string; body: Record<string, unknown> };

async function withFakeEndpoint(run: (baseUrl: string, requests: FakeRequest[]) => Promise<void>, replies: unknown[]) {
  const requests: FakeRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ path: new URL(String(input)).pathname, authorization: headers.get('Authorization') || undefined, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify(replies[Math.min(requests.length - 1, replies.length - 1)]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { await run('http://127.0.0.1:8080/v1/', requests); }
  finally { globalThis.fetch = originalFetch; }
}

function config(baseUrl: string): ProviderConfig {
  return { ...providerConfigFromEnv({}), baseUrl, timeoutMs: 1000 };
}

function completion(content: string) {
  return { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
}

const event = { id: 'event-1', text: 'I prefer short paragraphs.', author_role: 'user' as const, origin: 'user_explicit' as const };
const memory = { statement: 'Prefers short paragraphs.', kind: 'preference', source_event_id: event.id, quote: event.text, origin: 'user_explicit', subject: null, effective_at: null };

test('provider refuses fabricated evidence after one retry and preserves the model', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    await assert.rejects(provider.extract({ events: [event] }), error => error instanceof ProviderError && error.code === 'extraction_invalid_evidence');
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.body.model, 'nvidia/Nemotron-3_5-Lightning');
    assert.equal(requests[1]?.body.model, requests[0]?.body.model);
    assert.deepEqual(requests[0]?.body.response_format, { type: 'json_object' });
    assert.equal(requests[1]?.body.response_format, undefined);
    assert.equal(requests[0]?.authorization, undefined);
  }, [completion(JSON.stringify({ memories: [{ ...memory, quote: 'Fabricated quotation' }] }))]);
});

test('valid exact evidence is admitted and nullable optional schema fields are omitted', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 1);
    assert.equal(result.memories[0]?.origin, 'user_explicit');
    assert.equal(result.memories[0]?.subject, undefined);
    assert.equal(result.memories[0]?.effective_at, undefined);
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  }, [completion(JSON.stringify({ memories: [memory] }))]);
});

test('agent-reported summaries and assistant suggestions cannot become direct user statements', async () => {
  await withFakeEndpoint(async (baseUrl) => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    const summary = await provider.extract({ events: [{ ...event, author_role: 'assistant', origin: 'agent_reported' }] });
    assert.equal(summary.memories[0]?.origin, 'agent_reported');
    const suggestion = await provider.extract({ events: [{ ...event, author_role: 'assistant', origin: 'assistant_proposed' }] });
    assert.equal(suggestion.memories[0]?.origin, 'assistant_proposed');
  }, [completion(JSON.stringify({ memories: [memory] }))]);
});

test('the extractor cannot manufacture a user confirmation from a user statement', async () => {
  await withFakeEndpoint(async (baseUrl) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(result.memories[0]?.origin, 'user_explicit');
  }, [completion(JSON.stringify({ memories: [{ ...memory, origin: 'user_confirmed' }] }))]);
});

test('inferences supported by agent reports retain inference classification', async () => {
  await withFakeEndpoint(async (baseUrl) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [{ ...event, author_role: 'assistant', origin: 'agent_reported' }] });
    assert.equal(result.memories[0]?.origin, 'inferred');
  }, [completion(JSON.stringify({ memories: [{ ...memory, origin: 'inferred' }] }))]);
});

test('truncated or non-JSON thinking output is rejected, bounded repair usage is accumulated', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 2);
    assert.equal(result.memories.length, 1);
    assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 });
  }, [completion('Thinking: the user probably wants some memory.'), completion(JSON.stringify({ memories: [memory] }))]);
});

test('date-only or invented effective timestamps require repair instead of admission', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 2);
    assert.equal(result.memories[0]?.effective_at, undefined);
  }, [completion(JSON.stringify({ memories: [{ ...memory, effective_at: '2026-10-20' }] })), completion(JSON.stringify({ memories: [memory] }))]);
  await withFakeEndpoint(async (baseUrl) => {
    await assert.rejects(new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] }), error => error instanceof ProviderError && error.code === 'extraction_unsupported_effective_timestamp');
  }, [completion(JSON.stringify({ memories: [{ ...memory, effective_at: '2026-10-20T00:00:00Z' }] }))]);
});

test('embedding vectors are validated, ordered by response indices, and dimension changes fail', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'local-embedding-alias', timeoutMs: 1000 });
    const result = await provider.embed(['one', 'two']);
    assert.equal(result.dimensions, 3);
    assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
    assert.equal(requests[0]?.body.dimensions, undefined, 'probe may measure the natural dimension');
    await assert.rejects(provider.embed(['next']), error => error instanceof ProviderError && error.code === 'embedding_dimension_mismatch');
  }, [{ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] }, { data: [{ index: 0, embedding: [1, 0] }] }]);
});

test('same-dimensional embeddings from another model are rejected while matching or omitted identities remain supported', async () => {
  const data = [{ index: 0, embedding: [1, 0] }];
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'synthetic-selected', dimensions: 2, timeoutMs: 1000 });
    await assert.rejects(provider.embed(['synthetic context']), error => error instanceof ProviderError && error.code === 'embedding_model_mismatch');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await provider.embed(['synthetic context']);
      assert.equal(result.model, 'synthetic-selected');
      assert.deepEqual(result.vectors, [[1, 0]]);
    }
    assert.deepEqual(requests.map(request => request.body.model), ['synthetic-selected', 'synthetic-selected', 'synthetic-selected']);
  }, [{ model: 'synthetic-substituted', data }, { model: 'synthetic-selected', data }, { data }]);
});

test('empty or malformed supplied embedding model identities are invalid responses', async () => {
  for (const model of ['', '   ', ' synthetic-selected', 'synthetic-selected\n', null, 42, { id: 'synthetic-selected' }]) {
    await withFakeEndpoint(async baseUrl => {
      const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'synthetic-selected', dimensions: 2, timeoutMs: 1000 });
      await assert.rejects(provider.embed(['synthetic context']), error => error instanceof ProviderError && error.code === 'embedding_invalid_response');
    }, [{ model, data: [{ index: 0, embedding: [1, 0] }] }]);
  }
});

test('optional runtime embeddings require explicit pgvector dimensions without choosing a model', () => {
  assert.equal(createEmbeddingProvider({}), undefined);
  assert.equal(createEmbeddingProvider({ EMBEDDING_DIMENSIONS: '3' }), undefined);
  assert.throws(() => createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-embedding' }), /EMBEDDING_DIMENSIONS is required/);
  for (const dimensions of ['0', '-1', '1.5', 'NaN', '16001']) {
    assert.throws(() => createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-embedding', EMBEDDING_DIMENSIONS: dimensions }));
  }
  const provider = createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-4096', EMBEDDING_DIMENSIONS: '4096' });
  assert.equal(provider?.config.dimensions, 4096, 'storage-compatible dimensions are not restricted to ANN index limits');
  assert.equal(provider?.config.modelId, 'synthetic-4096');
  assert.equal(createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-16000', EMBEDDING_DIMENSIONS: '16000' })?.config.dimensions, 16000);
});

test('self-hosted embeddings send the configured dimension and never inherit a distinct endpoint key', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = createEmbeddingProvider({
      MODEL_BASE_URL: 'https://models.example.invalid/v1/', MODEL_API_KEY: 'synthetic-model-key', NEBIUS_API_KEY: 'synthetic-nebius-key',
      EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: 'self-hosted-reduced', EMBEDDING_DIMENSIONS: '3',
    });
    const result = await provider!.embed(['synthetic portable context']);
    assert.equal(requests[0]?.path, '/v1/embeddings');
    assert.equal(requests[0]?.authorization, undefined);
    assert.deepEqual(requests[0]?.body, {
      model: 'self-hosted-reduced', input: ['synthetic portable context'], encoding_format: 'float', dimensions: 3,
    });
    assert.deepEqual(result.vectors, [[Math.fround(0.1), 0, 1]]);
  }, [{ data: [{ index: 0, embedding: [0.1, 0, 1] }] }]);
});

test('embedding-specific credentials override shared endpoint credentials', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const env = { MODEL_BASE_URL: baseUrl, MODEL_API_KEY: 'synthetic-model-key', EMBEDDING_MODEL: 'local-alias', EMBEDDING_DIMENSIONS: '2' };
    await createEmbeddingProvider(env)!.embed(['synthetic one']);
    await createEmbeddingProvider({ ...env, EMBEDDING_API_KEY: 'synthetic-embedding-key' })!.embed(['synthetic two']);
    assert.equal(requests[0]?.authorization, 'Bearer synthetic-model-key');
    assert.equal(requests[1]?.authorization, 'Bearer synthetic-embedding-key');
  }, [{ data: [{ index: 0, embedding: [1, 0] }] }]);
});

test('valid high-dimensional batches are not restricted by the chat response size cap', async () => {
  const dimensions = 16_000;
  const data = Array.from({ length: 8 }, (_, index) => ({ index, embedding: Array.from({ length: dimensions }, () => 0.12345678901234567) }));
  assert.ok(JSON.stringify({ data }).length > 2_000_000);
  await withFakeEndpoint(async baseUrl => {
    const provider = createEmbeddingProvider({ EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: 'synthetic-large', EMBEDDING_DIMENSIONS: String(dimensions) });
    const result = await provider!.embed(data.map(({ index }) => `synthetic memory ${index}`));
    assert.equal(result.vectors.length, data.length);
    assert.equal(result.dimensions, dimensions);
  }, [{ data }]);
});

test('zero, non-float32, malformed, and mismatched embedding responses are rejected', async () => {
  const fixtures: { reply: unknown; code: string }[] = [
    { reply: { data: [{ index: 0, embedding: [0, 0] }] }, code: 'embedding_zero_vector' },
    { reply: { data: [{ index: 0, embedding: [1e100, 1] }] }, code: 'embedding_invalid_component' },
    { reply: { data: [{ index: 0, embedding: [1e-100, 1] }] }, code: 'embedding_invalid_component' },
    { reply: { data: [{ index: 0, embedding: [null, 1] }] }, code: 'embedding_invalid_response' },
    { reply: { data: [{ index: 0, embedding: ['1', 1] }] }, code: 'embedding_invalid_response' },
    { reply: { data: [] }, code: 'embedding_invalid_response' },
    { reply: { data: [{ index: 1, embedding: [1, 0] }] }, code: 'embedding_invalid_indices' },
    { reply: { data: [{ index: 0, embedding: [1, 0, 0] }] }, code: 'embedding_dimension_mismatch' },
  ];
  for (const { reply, code } of fixtures) {
    await withFakeEndpoint(async baseUrl => {
      const provider = createEmbeddingProvider({ EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: 'synthetic', EMBEDDING_DIMENSIONS: '2' });
      await assert.rejects(provider!.embed(['synthetic vector validation']), error => error instanceof ProviderError && error.code === code);
    }, [reply]);
  }
  await withFakeEndpoint(async baseUrl => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'synthetic', timeoutMs: 1000 });
    await assert.rejects(provider.embed(['synthetic one', 'synthetic two']), error => error instanceof ProviderError && error.code === 'embedding_invalid_indices');
  }, [{ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] }]);
});

test('embedding configuration is optional and does not send model key to a different endpoint', () => {
  assert.equal(embeddingConfigFromEnv({}), null);
  const distinct = embeddingConfigFromEnv({ MODEL_BASE_URL: 'https://one.example/v1/', MODEL_API_KEY: 'synthetic-secret', EMBEDDING_BASE_URL: 'http://localhost:8080/v1/', EMBEDDING_MODEL: 'local-embedding-alias' });
  assert.equal(distinct?.apiKey, undefined);
  assert.equal(providerConfigFromEnv({ MODEL_BASE_URL: 'http://localhost:8000/v1/', NEBIUS_API_KEY: 'synthetic-secret' }).apiKey, undefined);
  assert.throws(() => providerConfigFromEnv({ MODEL_BASE_URL: 'https://user:pass@example.com/v1/' }));
  assert.throws(() => providerConfigFromEnv({ MODEL_BASE_URL: 'synthetic-secret-invalid-url' }), error => error instanceof Error && !error.message.includes('synthetic-secret'));
});
