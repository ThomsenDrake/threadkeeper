import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
  ProviderError,
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
  await withFakeEndpoint(async (baseUrl) => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'local-embedding-alias', timeoutMs: 1000 });
    const result = await provider.embed(['one', 'two']);
    assert.equal(result.dimensions, 3);
    assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
    await assert.rejects(provider.embed(['next']), error => error instanceof ProviderError && error.code === 'embedding_dimension_mismatch');
  }, [{ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] }, { data: [{ index: 0, embedding: [1, 0] }] }]);
});

test('embedding configuration is optional and does not send model key to a different endpoint', () => {
  assert.equal(embeddingConfigFromEnv({}), null);
  const distinct = embeddingConfigFromEnv({ MODEL_BASE_URL: 'https://one.example/v1/', MODEL_API_KEY: 'synthetic-secret', EMBEDDING_BASE_URL: 'http://localhost:8080/v1/', EMBEDDING_MODEL: 'local-embedding-alias' });
  assert.equal(distinct?.apiKey, undefined);
  assert.equal(providerConfigFromEnv({ MODEL_BASE_URL: 'http://localhost:8000/v1/', NEBIUS_API_KEY: 'synthetic-secret' }).apiKey, undefined);
  assert.throws(() => providerConfigFromEnv({ MODEL_BASE_URL: 'https://user:pass@example.com/v1/' }));
});
