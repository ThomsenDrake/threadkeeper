import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createFixture, FIXTURE_EMBEDDING_MODEL } from '../deploy/integration/provider-fixture.ts';
import {
  OpenAICompatibleEmbeddingProvider, OpenAICompatibleProvider, ProviderError, providerConfigFromEnv,
} from '../packages/providers/src/index.ts';

async function withFixture(run: (baseUrl: string, control: (path: string, body?: unknown) => Promise<any>) => Promise<void>) {
  const fixture = createFixture();
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  async function control(path: string, body?: unknown) {
    const response = await fetch(`${origin}/control/${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  try { await run(`${origin}/v1/`, control); }
  finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
}

function embeddings(baseUrl: string) {
  return new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: FIXTURE_EMBEDDING_MODEL, dimensions: 3, timeoutMs: 3000 });
}

async function waitForHeld(control: (path: string) => Promise<any>, kind: 'heldChat' | 'heldEmbeddings') {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await control('status'))[kind] > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Fixture did not hold ${kind}`);
}

test('synthetic HTTP fixture exercises real adapters with source evidence and separate inference attribution', async () => {
  await withFixture(async (baseUrl, control) => {
    const provider = new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl, timeoutMs: 3000 });
    const result = await provider.extract({ events: [
      { id: 'deadline-v1', text: 'The Atlas deadline is 20 October 2026.', author_role: 'user', origin: 'user_explicit' },
      { id: 'writing-v1', text: 'Use short paragraphs in my writing.', author_role: 'user', origin: 'user_explicit' },
      { id: 'proposal-v1', text: 'Schedule a synthetic showcase.', author_role: 'assistant', origin: 'assistant_proposed' },
      { id: 'agent-v1', text: 'The synthetic rehearsal completed.', author_role: 'assistant', origin: 'agent_reported' },
    ] });
    assert.equal(result.model, provider.config.modelId);
    assert.equal(result.memories.length, 5);
    const inference = result.memories.find(memory => memory.origin === 'inferred');
    assert.equal(inference?.quote, 'Use short paragraphs in my writing.');
    assert.equal(inference?.source_event_id, 'writing-v1');
    assert.equal(result.memories.find(memory => memory.source_event_id === 'proposal-v1')?.origin, 'assistant_proposed');
    assert.equal(result.memories.find(memory => memory.source_event_id === 'agent-v1')?.origin, 'agent_reported');
    const vectors = await embeddings(baseUrl).embed([result.memories[0]!.statement, result.memories[1]!.statement, 'milestones and prose style']);
    assert.deepEqual(vectors.vectors, [[1, 0, 0], [0, 1, 0], [1, 1, 0]]);
    const status = await control('status');
    assert.equal(status.chatRequests, 1);
    assert.equal(status.embeddingRequests, 1);
    assert.deepEqual(status.models, [provider.config.modelId, FIXTURE_EMBEDDING_MODEL].sort());
    assert.deepEqual(status.dimensions, [3]);
    assert.equal(status.authorizationSeen, false);
    assert.ok(!JSON.stringify(status).includes('Atlas'), 'Status must omit source text.');
  });
});

test('synthetic HTTP fault modes make adapters reject model substitution and dimension changes and recover', async () => {
  await withFixture(async (baseUrl, control) => {
    const provider = embeddings(baseUrl);
    for (const [embeddingMode, code] of [
      ['http-error', 'provider_http_error'],
      ['wrong-model', 'embedding_model_mismatch'],
      ['wrong-dimensions', 'embedding_dimension_mismatch'],
    ]) {
      await control('configure', { embeddingMode });
      await assert.rejects(provider.embed(['A synthetic deadline.']), error => error instanceof ProviderError && error.code === code);
    }
    await control('configure', { embeddingMode: 'ok' });
    assert.deepEqual((await provider.embed(['A synthetic deadline.'])).vectors, [[1, 0, 0]]);
    const extractor = new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl, timeoutMs: 3000 });
    await control('configure', { chatMode: 'wrong-model' });
    await assert.rejects(extractor.extract({ events: [
      { id: 'synthetic-event', text: 'A synthetic deadline.', author_role: 'user', origin: 'user_explicit' },
    ] }), error => error instanceof ProviderError && error.code === 'provider_model_mismatch');
    assert.equal((await control('status')).chatRequests, 2, 'Extraction repair preserves the configured model on both requests.');
  });
});

test('held provider replies snapshot output and fault mode before configuration changes', async () => {
  await withFixture(async (baseUrl, control) => {
    await control('configure', { holdEmbeddings: true, holdChat: true });
    const vectorPromise = embeddings(baseUrl).embed(['A synthetic deadline.']);
    const extractionPromise = new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl, timeoutMs: 3000 }).extract({ events: [
      { id: 'synthetic-event', text: 'A synthetic deadline.', author_role: 'user', origin: 'user_explicit' },
    ] });
    await waitForHeld(control, 'heldEmbeddings');
    await waitForHeld(control, 'heldChat');
    await control('configure', { embeddingMode: 'wrong-model', chatMode: 'wrong-model' });
    await control('release', {});
    assert.deepEqual((await vectorPromise).vectors, [[1, 0, 0]]);
    assert.equal((await extractionPromise).memories[0]?.statement, 'A synthetic deadline.');
    const status = await control('status');
    assert.equal(status.heldChat + status.heldEmbeddings, 0);
    assert.equal(status.completedChat, 1);
    assert.equal(status.completedEmbeddings, 1);
    await control('reset', {});
    const reset = await control('status');
    assert.equal(reset.chatRequests + reset.embeddingRequests + reset.completedChat + reset.completedEmbeddings, 0);
    assert.deepEqual(reset.models, []);
    assert.deepEqual(reset.dimensions, []);
  });
});
