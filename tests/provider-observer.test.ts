import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDirectProviderObserver, summarizeProviderObservations } from '../deploy/direct-provider-observer.mjs';
import { OpenAICompatibleProvider, providerConfigFromEnv } from '../packages/providers/src/index.ts';

const model = 'nvidia/Nemotron-3_5-Lightning';
const baseUrl = 'http://127.0.0.1:18818/v1/';
const event = { id: 'synthetic-source', text: 'I prefer concise updates.', author_role: 'user' as const, origin: 'user_explicit' as const };

test('direct observation accounts for both rejected extraction responses without retaining source or credentials', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), baseUrl + 'chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-secret');
    assert(JSON.parse(String(init?.body)).messages[1].content.includes(event.text));
    return new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: 'Unusable synthetic output' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
        completion_tokens_details: { reasoning_tokens: 2, private_content: 'secret-response-text' },
        private_content: 'secret-response-text', 'secret-field-name': 123 },
    }));
  };
  const observer = installDirectProviderObserver({ baseUrl });
  try {
    const provider = new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl, apiKey: 'synthetic-secret' });
    await assert.rejects(provider.extract({ events: [event] }), /extraction_invalid_json/);
    assert.equal(calls, 2);
    assert.equal(observer.records.length, 2);
    assert(observer.records.every(record => record.sent && record.http_status === 200 && record.finish_reason === 'stop' && record.returned_model_matches));
    assert(observer.records.every(record => record.request_sha256?.length === 64 && record.response_sha256?.length === 64 && record.elapsed_ms >= 0));
    assert.deepEqual(summarizeProviderObservations(observer.records), {
      observed_attempt_count: 2, direct_request_count: 2, inference_request_count: 2,
      usage_complete: true, inference_requests_without_usage: 0, inference_requests_without_complete_usage: 0,
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, completion_tokens_details: { reasoning_tokens: 4 } },
    });
    const serialized = JSON.stringify(observer.records);
    for (const secret of ['synthetic-secret', event.text, 'Unusable synthetic output', 'secret-response-text', 'secret-field-name', 'Authorization']) assert(!serialized.includes(secret));
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});

test('HTTP errors, absent usage and network failures stay visible while original direct responses and errors are preserved', async () => {
  const originalFetch = globalThis.fetch;
  const networkError = new Error('synthetic-sensitive-network-error');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 3) throw networkError;
    return new Response(calls === 1 ? JSON.stringify({ model: 'synthetic-private-model', error: { message: 'synthetic-sensitive-provider-error' } }) : 'synthetic-sensitive-invalid-json', { status: calls === 1 ? 429 : 200 });
  };
  const observer = installDirectProviderObserver({ baseUrl });
  try {
    const first = await fetch(baseUrl + 'chat/completions', { method: 'POST', body: JSON.stringify({ model }) });
    assert.equal(first.status, 429);
    assert((await first.text()).includes('synthetic-sensitive-provider-error'));
    const second = await fetch(baseUrl + 'embeddings', { method: 'POST', body: JSON.stringify({ model, input: ['synthetic embedding input'] }) });
    assert.equal(await second.text(), 'synthetic-sensitive-invalid-json');
    await assert.rejects(fetch(baseUrl + 'chat/completions'), error => error === networkError);
    assert.equal(observer.records[0].returned_model_matches, false);
    assert.equal(observer.records[0].returned_model, undefined);
    assert.equal(observer.records[1].input_count, 1);
    assert.equal(observer.records[2].outcome, 'network_error');
    assert.equal(summarizeProviderObservations(observer.records).usage_complete, false);
    assert.equal(summarizeProviderObservations(observer.records).inference_requests_without_usage, 3);
    const serialized = JSON.stringify(observer.records);
    for (const hidden of ['synthetic-private-model', 'synthetic-sensitive', 'synthetic embedding input']) assert(!serialized.includes(hidden));
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});

test('opt-in request budgets fence direct calls and unrelated URLs are neither observed nor modified', async () => {
  const originalFetch = globalThis.fetch;
  const received: Array<[unknown, unknown]> = [];
  globalThis.fetch = async (input, init) => { received.push([input, init]); return new Response('{}'); };
  const observer = installDirectProviderObserver({ baseUrl, limits: { 'chat/completions': 1 } });
  try {
    const init = { method: 'POST', body: JSON.stringify({ model }) };
    await fetch(baseUrl + 'chat/completions', init);
    await assert.rejects(fetch(baseUrl + 'chat/completions', init), /provider_observation_request_budget_exhausted/);
    const unrelated = baseUrl + 'chat/completions?secret=synthetic-query-secret';
    await fetch(unrelated, init);
    assert.equal(received.length, 2);
    assert.equal(received[0][1], init);
    assert.deepEqual(received[1], [unrelated, init]);
    assert.equal(observer.records.length, 2);
    assert.equal(observer.records[1].sent, false);
    assert.equal(observer.records[1].outcome, 'budget_exhausted');
    assert.equal(summarizeProviderObservations(observer.records).direct_request_count, 1);
    assert(!JSON.stringify(observer.records).includes('synthetic-query-secret'));
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});

test('provider probe preserves synthetic extraction evidence and full attempt accounting when its semantic rubric fails', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: model }] })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    let message: Record<string, unknown> = { content: 'READY' };
    if (body.tools) {
      const nonce = body.messages[0].content.match(/nonce ([^. ]+)/)[1];
      message = { content: null, tool_calls: [{ id: 'synthetic-tool', type: 'function', function: { name: 'record_probe', arguments: JSON.stringify({ nonce }) } }] };
    } else if (body.messages[0].role === 'system') {
      message = { content: JSON.stringify({ memories: [{ statement: 'The Lumen demo deadline is October 20, 2026.', kind: 'fact',
        source_event_id: 'provider-check-user-1', quote: 'The Lumen demo deadline is October 20, 2026.', origin: 'user_explicit' }] }) };
    } else if (body.response_format) message = { content: JSON.stringify({ ok: true, deadline: '2026-10-20' }) };
    response.end(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
      completion_tokens_details: { reasoning_tokens: 0 } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'deploy/provider-check.ts'], {
      cwd: process.cwd(), env: { ...process.env, MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1/`, MODEL_ID: model,
        MODEL_API_KEY: 'synthetic-probe-secret', MODEL_REASONING_EFFORT: 'none', EMBEDDING_MODEL: '', PROVIDER_CHECK_SCHEMA: 'false',
        THREADKEEPER_PROVIDER_OBSERVATIONS_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, stderr);
    const result = JSON.parse(stdout);
    const extraction = result.checks.find((check: any) => check.check === 'source_backed_extraction');
    assert.equal(extraction.reason, 'extraction_missing_preference');
    assert.equal(extraction.extraction.expected_deadline, true);
    assert.equal(extraction.extraction.expected_preference, false);
    assert.equal(extraction.extraction.memories.length, 1);
    assert.equal(extraction.provider_attempts.length, 1);
    assert.equal(result.provider_accounting.direct_request_count, 5);
    assert.equal(result.provider_accounting.inference_request_count, 4);
    assert.equal(result.provider_accounting.usage_complete, true);
    assert.equal(result.provider_accounting.usage.total_tokens, 56);
    assert.equal(result.provider_accounting.usage.completion_tokens_details.reasoning_tokens, 0);
    assert(!stdout.includes('synthetic-probe-secret'));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


test('partial token fields remain reported while completeness requires a total or complete input/output pair', async () => {
  const originalFetch = globalThis.fetch;
  const usages = [
    { completion_tokens_details: { reasoning_tokens: 0 } }, { prompt_tokens: 12 },
    { prompt_tokens: 12, completion_tokens: 3 }, { input_tokens: 12, output_tokens: 3 }, { total_tokens: 15 },
  ];
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: usages[calls++] }));
  const observer = installDirectProviderObserver({ baseUrl });
  try {
    for (const _ of usages) await fetch(baseUrl + 'chat/completions');
    assert(observer.records.every(record => record.usage_status === 'reported'));
    assert.deepEqual(observer.records.map(record => summarizeProviderObservations([record]).usage_complete), [false, false, true, true, true]);
    const summary = summarizeProviderObservations(observer.records);
    assert.equal(summary.usage_complete, false);
    assert.equal(summary.inference_requests_without_usage, 0);
    assert.equal(summary.inference_requests_without_complete_usage, 2);
    assert.equal(summary.usage.completion_tokens_details && (summary.usage.completion_tokens_details as any).reasoning_tokens, 0);
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});
