import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, chmod, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { OpenCodeProviderGuard, type OpenCodeGuardConfig, type OpenCodeGuardRecord } from '../deploy/opencode-provider-guard.mjs';

const endpoint = 'https://api.tokenfactory.nebius.com/v1/chat/completions';
const model = 'nvidia/Nemotron-3_5-Lightning';
const key = 'synthetic-private-provider-key';
const content = 'synthetic-private-prompt-and-response';
const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
  prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: null } };
const payload = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (value: unknown = usage) => payload({ model, choices: [{ delta: { content } }], usage: null })
  + payload({ model, choices: [], usage: value }) + 'data: [DONE]\n\n';
const response = (text = sse()) => new Response(text, { headers: { 'content-type': 'text/event-stream', 'x-synthetic': 'preserved' } });
function config(): OpenCodeGuardConfig {
  return { enabled_providers: ['tk-nebius'], provider: { 'tk-nebius': { npm: '@ai-sdk/openai-compatible', env: [],
    options: { baseURL: 'https://api.tokenfactory.nebius.com/v1/' } } } };
}
function request(overrides: Record<string, unknown> = {}): RequestInit {
  return { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({
    model, reasoning_effort: 'none', max_tokens: 1024, stream: true,
    messages: [{ role: 'user', content }],
    tools: [{ type: 'function', function: { name: 'threadkeeper_context_search', parameters: { type: 'object' } } }],
    ...overrides,
  }) };
}
async function harness(originalFetch: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-guard-test-'));
  const logPath = join(directory, 'private.jsonl');
  await writeFile(logPath, '', { mode: 0o600 });
  const hook = OpenCodeProviderGuard.createForTest({ apiKey: key, logPath, originalFetch });
  const cfg = config(); hook.config(cfg);
  const call = cfg.provider!['tk-nebius']!.options!.fetch!;
  return { directory, logPath, hook, cfg, call,
    records: async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as OpenCodeGuardRecord),
    close: async () => { hook.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('OpenCode guard streams exact original bytes and retains only safe, complete usage evidence', async () => {
  const text = sse().replaceAll('\n', '\r\n');
  const bytes = new TextEncoder().encode(text);
  let pulls = 0;
  const h = await harness(async (input, init) => {
    assert.equal(input instanceof Request ? input.url : String(input), endpoint);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${key}`);
    assert.equal(JSON.parse(String(init?.body)).messages[0].content, content);
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(pulls, ++pulls));
      },
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-synthetic': 'preserved' } });
  });
  try {
    const res = await h.call(new Request(endpoint), request());
    assert(pulls < bytes.length, 'guard must not pre-drain the provider response');
    assert.equal(res.headers.get('x-synthetic'), 'preserved');
    assert.equal(await res.text(), text);
    const records = await h.records();
    assert.equal(records.length, 3);
    assert.deepEqual(records[1]?.tool_names, ['threadkeeper_context_search']);
    assert.equal(records[1]?.message_count, 1);
    assert.equal(records[2]?.usage_complete, true);
    assert.equal(records[2]?.returned_model_matches, true);
    assert.equal(records[2]?.done_seen, true);
    assert.deepEqual(records[2]?.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
      completion_tokens_details: { reasoning_tokens: 0 } });
    const log = JSON.stringify(records);
    for (const secret of [key, content, 'Authorization', 'parameters']) assert(!log.includes(secret));
  } finally { await h.close(); }
});

test('OpenCode guard caps four total direct attempts including concurrent retries', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return response(); });
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 7 }, () => h.call(endpoint, request())));
    assert.equal(calls, 4);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 4);
    for (const value of outcomes) {
      if (value.status === 'fulfilled') await value.value.text();
      else assert.equal(value.reason.message, 'opencode_guard_request_budget_exhausted');
    }
    const records = await h.records();
    assert.deepEqual(records.filter(record => record.event === 'opencode_provider_request').map(record => record.ordinal), [1, 2, 3, 4]);
    assert.deepEqual(records.filter(record => record.event === 'opencode_provider_denied').map(record => record.ordinal), [5, 6, 7]);
  } finally { await h.close(); }
  let retryCalls = 0;
  const broken = await harness(async () => { retryCalls++; throw new Error(key + content); });
  try {
    for (let index = 0; index < 5; index++) {
      await assert.rejects(broken.call(endpoint, request()), { message: index < 4 ? 'opencode_provider_network_error' : 'opencode_guard_request_budget_exhausted' });
    }
    assert.equal(retryCalls, 4);
    const log = JSON.stringify(await broken.records());
    assert(!log.includes(key)); assert(!log.includes(content));
    assert.equal((await broken.records()).filter(record => record.outcome === 'network_error').length, 4);
  } finally { await broken.close(); }
});

test('OpenCode guard rejects alternate endpoints, unsafe requests and output-cap ambiguity before fetch', async () => {
  const cases: Array<[string, RequestInit]> = [
    [endpoint + '?key=' + key, request()],
    [endpoint.replace('https:', 'http:'), request()],
    [endpoint, { ...request(), method: 'GET' }],
    [endpoint, { ...request(), headers: { Authorization: 'Bearer wrong' } }],
    [endpoint, request({ model: 'alternate-model' })],
    [endpoint, request({ reasoning_effort: 'low' })],
    [endpoint, request({ max_tokens: 1025 })],
    [endpoint, request({ max_tokens: 0 })],
    [endpoint, request({ max_completion_tokens: 1024 })],
    [endpoint, request({ n: 2 })],
    [endpoint, request({ stream: false })],
    [endpoint, request({ messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'synthetic' })) })],
    [endpoint, request({ messages: [{ role: 'user', content: 'x'.repeat(120_001) }] })],
    [endpoint, request({ tools: [{ type: 'function', function: { name: 'bash' } }] })],
  ];
  for (const [url, init] of cases) {
    let calls = 0;
    const h = await harness(async () => { calls++; return response(); });
    try {
      await assert.rejects(h.call(url, init), /opencode_guard_/);
      assert.equal(calls, 0);
      assert.equal((await h.records())[1]?.sent, false);
      assert(!JSON.stringify(await h.records()).includes(key));
    } finally { await h.close(); }
  }
});

test('OpenCode stream evidence preserves malformed usage and model contradictions without raw values', async () => {
  const malformed = [
    sse({ ...usage, total_tokens: null }),
    sse({ ...usage, total_tokens: '14' }),
    sse({ ...usage, total_tokens: -1 }),
    sse({ ...usage, total_tokens: 15 }),
    sse({ ...usage, input_tokens: 100, output_tokens: 100 }),
    sse({ ...usage, input_tokens: 10, output_tokens: 5 }),
    sse({ input_tokens: 10, output_tokens: 5, total_tokens: 14 }),
    sse({ prompt_tokens: 15, total_tokens: 14 }),
    sse({ output_tokens: 15, total_tokens: 14 }),
    sse({ prompt_tokens: 10, output_tokens: 5, total_tokens: 14 }),
    sse({ input_tokens: 10, completion_tokens: 5, total_tokens: 14 }),
    sse({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 99 } }),
    sse({ total_tokens: 14, completion_tokens_details: { reasoning_tokens: 15 } }),
    sse({ ...usage, output_tokens_details: { audio_tokens: 5 } }),
    sse({ ...usage, input_tokens_details: { cached_tokens: 11 } }),
    sse({ ...usage, prompt_tokens_details: { audio_tokens: 11 } }),
    sse({ ...usage, completion_tokens_details: { prompt_tokens_details: { audio_tokens: 5 } } }),
    sse({ ...usage, completion_tokens_details: { reasoning_tokens: 'sensitive-value' } }),
    payload({ model, usage: { ...usage, prompt_tokens: null } }) + sse(),
    payload({ model, usage: { ...usage, prompt_tokens: 11, total_tokens: 15 } }) + sse(),
    payload({ model: 'sensitive-alternate-model', usage: null }) + sse(),
    payload({ model: null }) + sse(),
  ];
  for (const text of malformed) {
    const h = await harness(async () => response(text));
    try {
      assert.equal(await (await h.call(endpoint, request())).text(), text);
      const records = await h.records();
      assert.equal(records.at(-1)?.usage_complete, false);
      const log = JSON.stringify(records);
      assert(!log.includes('sensitive-value')); assert(!log.includes('sensitive-alternate-model'));
      if (text.includes('alternate-model') || text.includes('"model":null')) assert.equal(records.at(-1)?.returned_model_matches, false);
      else assert.equal(records.at(-1)?.usage_invalid, true);
    } finally { await h.close(); }
  }
});

test('shared strict chat usage predicate bounds every recognized detail independently and reconciles count families', () => {
  const complete = OpenCodeProviderGuard.usageIsComplete;
  const base = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  assert.equal(complete(base), true);
  assert.equal(complete({ ...base, input_tokens: 10, output_tokens: 5 }), true);
  assert.equal(complete({ ...base, completion_tokens_details: { reasoning_tokens: 4, audio_tokens: 4 } }), true,
    'overlapping detail categories must not be summed');
  assert.equal(complete({ ...base, prompt_tokens_details: null,
    completion_tokens_details: { reasoning_tokens: null, audio_tokens: 5 } }), true);
  const counts = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
    'cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];
  for (const [details, parent] of Object.entries({
    prompt_tokens_details: 10, input_tokens_details: 10, completion_tokens_details: 5, output_tokens_details: 5,
  })) {
    for (const count of counts) {
      assert.equal(complete({ ...base, [details]: { [count]: parent } }), true, `${details}.${count} at parent`);
      assert.equal(complete({ ...base, [details]: { [count]: parent + 1 } }), false, `${details}.${count} exceeds parent`);
    }
  }
  for (const value of [undefined, null, [], {}, { total_tokens: 15 }, { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    { ...base, total_tokens: '15' }, { ...base, total_tokens: null },
    { ...base, input_tokens: 11 }, { ...base, output_tokens: 6 },
    { ...base, completion_tokens_details: { reasoning_tokens: '99' } },
    { ...base, completion_tokens_details: { output_tokens_details: { reasoning_tokens: 6 } } },
    { prompt_tokens: 10, output_tokens: 6, total_tokens: 15 },
  ]) assert.equal(complete(value), false);
});

test('OpenCode stream evidence requires DONE, exact model, readable bounded events and clean completion', async () => {
  const incomplete = [
    sse({ prompt_tokens: 10, total_tokens: 14 }),
    sse({ input_tokens: 10, output_tokens: 4, total_tokens: 14 }),
    sse().replace('data: [DONE]\n\n', ''),
    sse().replaceAll(`"model":"${model}",`, ''),
    sse().slice(0, -1),
    'data: not-json\n\n' + sse(),
    sse() + payload({ model, usage }),
    payload({ model, choices: [{ delta: { content: 'x'.repeat(65_537) } }] }) + sse(),
    (': ' + 'x'.repeat(1024) + '\n\n').repeat(2048) + sse(),
  ];
  for (const text of incomplete) {
    const h = await harness(async () => response(text));
    try {
      assert.equal(await (await h.call(endpoint, request())).text(), text);
      assert.equal((await h.records()).at(-1)?.usage_complete, false);
    } finally { await h.close(); }
  }
  for (const result of [new Response(sse(), { headers: { 'content-type': 'application/json' } }),
    new Response(sse(), { status: 503, headers: { 'content-type': 'text/event-stream' } })]) {
    const h = await harness(async () => result);
    try {
      await (await h.call(endpoint, request())).text();
      assert.equal((await h.records()).at(-1)?.usage_complete, false);
    } finally { await h.close(); }
  }
});

test('OpenCode stream cancellation and read errors stay incomplete even after valid usage', async () => {
  let cancelled = false;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(sse())); },
    cancel() { cancelled = true; },
  });
  const h = await harness(async () => new Response(original, { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const reader = (await h.call(endpoint, request())).body!.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(cancelled, true);
    assert.equal(original.locked, false);
    const record = (await h.records()).at(-1)!;
    assert.equal(record.done_seen, true); assert.equal(record.usage_status, 'reported');
    assert.equal(record.stream_status, 'cancelled'); assert.equal(record.usage_complete, false);
  } finally { await h.close(); }
  let first = true;
  const broken = new ReadableStream<Uint8Array>({ pull(controller) {
    if (first) { first = false; controller.enqueue(new TextEncoder().encode(sse())); }
    else controller.error(new Error(key + content));
  } });
  const b = await harness(async () => new Response(broken, { headers: { 'content-type': 'text/event-stream' } }));
  try {
    await assert.rejects((await b.call(endpoint, request())).text(), /opencode_provider_stream_error/);
    const record = (await b.records()).at(-1)!;
    assert.equal(record.usage_complete, false); assert.equal(record.stream_status, 'read_error');
    assert.equal(broken.locked, false);
    assert(!JSON.stringify(record).includes(key));
  } finally { await b.close(); }
});

test('OpenCode guard key installation is single, atomic and private-log dependent', async () => {
  const h = await harness(async () => response());
  try {
    assert.equal(h.cfg.provider!['tk-nebius']!.options!.apiKey, key);
    assert.throws(() => h.hook.config(config()), /opencode_guard_duplicate_configuration/);
    await assert.rejects(h.call(endpoint, request()), /opencode_guard_not_active/);
  } finally { await h.close(); }
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-config-test-'));
  const logPath = join(directory, 'private.jsonl');
  try {
    await writeFile(logPath, '', { mode: 0o600 });
    for (const change of [
      (cfg: OpenCodeGuardConfig) => { cfg.enabled_providers!.push('other'); },
      (cfg: OpenCodeGuardConfig) => { cfg.provider!['other'] = { env: [] }; },
      (cfg: OpenCodeGuardConfig) => { cfg.provider!['tk-nebius']!.env = ['NEBIUS_API_KEY']; },
      (cfg: OpenCodeGuardConfig) => { cfg.provider!['tk-nebius']!.options!.apiKey = ''; },
      (cfg: OpenCodeGuardConfig) => { cfg.provider!['tk-nebius']!.options!.fetch = fetch; },
    ]) {
      const hook = OpenCodeProviderGuard.createForTest({ apiKey: key, logPath, originalFetch: async () => response() });
      const cfg = config(); change(cfg);
      try {
        assert.throws(() => hook.config(cfg), /opencode_guard_initial_provider_not_keyless/);
        assert.notEqual(cfg.provider!['tk-nebius']!.options!.apiKey, key);
      } finally { hook.close(); }
    }
    await chmod(logPath, 0o644);
    assert.throws(() => OpenCodeProviderGuard.createForTest({ apiKey: key, logPath, originalFetch: fetch }), /opencode_guard_log_not_private/);
    await chmod(logPath, 0o600);
    const link = join(directory, 'symlink.jsonl'); await symlink(logPath, link);
    assert.throws(() => OpenCodeProviderGuard.createForTest({ apiKey: key, logPath: link, originalFetch: fetch }), /opencode_guard_log_not_private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production plugin initialization cannot reset the process budget or install credentials twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-plugin-test-'));
  const logPath = join(directory, 'private.jsonl');
  await writeFile(logPath, '', { mode: 0o600 });
  const script = `
    import assert from 'node:assert/strict';
    import { OpenCodeProviderGuard } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'deploy/opencode-provider-guard.mjs')).href)};
    globalThis.fetch = async () => { throw new Error('network must not be reached'); };
    const first = await OpenCodeProviderGuard();
    const config = ${JSON.stringify(config())};
    first.config(config);
    await assert.rejects(OpenCodeProviderGuard(), /opencode_guard_already_installed/);
    await assert.rejects(config.provider['tk-nebius'].options.fetch(${JSON.stringify(endpoint)}, ${JSON.stringify(request())}), /opencode_guard_not_active/);
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env: {
      PATH: process.env.PATH, TK_OPENCODE_API_KEY: key, TK_OPENCODE_GUARD_LOG: logPath,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr);
    const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(record => record.event === 'opencode_guard_ready').length, 1);
    assert.equal(records.filter(record => record.sent === true).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OpenCode guard fails closed if its evidence log is replaced before credential installation or fetch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-log-test-'));
  const logPath = join(directory, 'private.jsonl');
  await writeFile(logPath, '', { mode: 0o600 });
  const hook = OpenCodeProviderGuard.createForTest({ apiKey: key, logPath, originalFetch: fetch });
  const cfg = config();
  try {
    await rename(logPath, join(directory, 'original.jsonl'));
    await writeFile(logPath, '', { mode: 0o600 });
    assert.throws(() => hook.config(cfg), /opencode_guard_log_write_failed/);
    assert.equal(cfg.provider!['tk-nebius']!.options!.apiKey, undefined);
    assert.equal(cfg.provider!['tk-nebius']!.options!.fetch, undefined);
  } finally { hook.close(); await rm(directory, { recursive: true, force: true }); }
  let calls = 0;
  const h = await harness(async () => { calls++; return response(); });
  try {
    await rename(h.logPath, join(h.directory, 'original.jsonl'));
    await writeFile(h.logPath, '', { mode: 0o600 });
    await assert.rejects(h.call(endpoint, request()), /opencode_guard_log_write_failed/);
    assert.equal(calls, 0);
  } finally { await h.close(); }
});
