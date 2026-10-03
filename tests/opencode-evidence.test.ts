import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bootstrap } from '../apps/api/src/auth.ts';
import { createApp } from '../apps/api/src/app.ts';
import { createTestDatabase } from './helpers.ts';
import { assertCaptureEvidence, assertRecallEvidence, observeMcpCall, opencodeProject, parseMcpToolResponse, type McpEvidence, type McpPhase } from '../deploy/opencode-evidence.ts';
import { directLearnedCase } from '../deploy/integration/learned-assertions.ts';
import { assertHostResult, opencodeEnvironment, runOpenCodeHost, type HostResult } from '../deploy/opencode-host.ts';

test('actual MCP application wire evidence distinguishes source capture and current canonical recall from fabricated fixture answers', async () => {
  const database = await createTestDatabase(), server = createServer();
  const client = new Client({ name: 'synthetic-opencode-evidence-unit', version: '1' });
  const records: McpEvidence[] = [], failures: string[] = [];
  let phase: McpPhase | undefined;
  try {
    await bootstrap(database.db, 'synthetic@example.invalid', 'synthetic-unit-password');
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    const { app, store } = createApp(database.db, { origin: base }); const wrapper = express(); wrapper.use(express.json());
    wrapper.use((req, res, next) => { if (phase && req.path === '/mcp') observeMcpCall(req, res, phase, records, failures); next(); });
    wrapper.use(app); server.on('request', wrapper);
    let cookie = '';
    const http = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert(response.ok); return { data: await response.json() as any, response };
    };
    const login = await http('/api/auth/login', { email: 'synthetic@example.invalid', password: 'synthetic-unit-password' }); cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    const grant = (await http('/api/clients', { name: 'Synthetic unit client', permissions: ['read', 'capture'], projects: [opencodeProject] })).data;
    phase = { id: 'capture-a', client_id: grant.client.id, token: grant.token, started: 0, rpc_ids: new Set() };
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
    await client.callTool({ name: 'context_capture', arguments: { idempotency_key: 'installed-opencode-capture', project_id: opencodeProject, events: directLearnedCase.events } });
    assert.deepEqual(failures, []);
    assertCaptureEvidence(records);
    assert.equal(phase.started, 1); assert.deepEqual(failures, []);
    const explicit = structuredClone(records); explicit[0].arguments.explicit_memories = [];
    assert.throws(() => assertCaptureEvidence(explicit), /fabricate/);
    const rewritten = structuredClone(records); (rewritten[0].arguments.events as any[])[0].text = 'The source was rewritten.';
    assert.throws(() => assertCaptureEvidence(rewritten), /source events/);
    // Controlled extraction exists only in this credential-free helper test.
    await store.processJob({ extract: async () => ({ model: 'synthetic-unit-provider', memories: directLearnedCase.events.map((event, index) => ({
      statement: event.text, kind: index ? 'preference' : 'fact', source_event_id: event.id, quote: event.text, origin: event.origin,
    })) }) });
    const canonical = (await http(`/api/memories?project_id=${opencodeProject}`)).data.memories;
    phase = { ...phase, id: 'recall-b', started: 0, rpc_ids: new Set() };
    await client.callTool({ name: 'context_search', arguments: { project_id: opencodeProject, query: '', limit: 10 } });
    const recalls = records.filter(record => record.phase === 'recall-b'); assertRecallEvidence(recalls, 'recall-b', canonical);
    const stale = structuredClone(recalls); stale[0].result.memories[0].statement = 'A fabricated old deadline.';
    assert.throws(() => assertRecallEvidence(stale, 'recall-b', canonical), /canonical statement/);
    const omitted = structuredClone(recalls); omitted[0].result.memories.pop();
    assert.throws(() => assertRecallEvidence(omitted, 'recall-b', canonical), /omitted or fabricated/);
    assert.throws(() => assertRecallEvidence([...recalls, ...recalls], 'recall-b', canonical), /Duplicate/);
  } finally {
    await client.close();
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    await database.close();
  }
});

test('host acceptance requires actual clean completion, single guard, exact tool exposure and complete response accounting', () => {
  const result: HostResult = { phase: 'recall-b', code: 0, signal: null, closed: true, group_terminated: true, timed_out: false, output_valid: true, session_ids: ['synthetic-session'],
    completed: true, error_event: false, tool_events: [{ name: 'threadkeeper_context_search', status: 'completed' }], provider: [
      { event: 'opencode_guard_ready', config_invocations: 1 },
      { event: 'opencode_provider_request', ordinal: 1, requested_model: 'nvidia/Nemotron-3_5-Lightning', reasoning_effort: 'none', stream: true, max_tokens: 1024, tool_names: ['threadkeeper_context_search'] },
      { event: 'opencode_provider_result', ordinal: 1, outcome: 'http_response', http_status: 200, usage_complete: true, returned_model_matches: true },
    ] };
  assertHostResult(result);
  for (const mutate of [
    (value: HostResult) => { value.completed = false; },
    (value: HostResult) => { value.error_event = true; },
    (value: HostResult) => { value.provider[1].tool_names.push('bash'); },
    (value: HostResult) => { value.provider[2].usage_complete = false; },
    (value: HostResult) => { value.provider.push(value.provider[2]); },
    (value: HostResult) => { value.provider.push({ event: 'opencode_guard_failed' }); },
    (value: HostResult) => { value.provider[0].config_invocations = 2; },
  ]) { const changed = structuredClone(result); mutate(changed); assert.throws(() => assertHostResult(changed)); }
});

test('MCP response observation rejects unpaired, duplicate, truncated or conflicting text/structured results', () => {
  const data = { memories: [] }, response = { jsonrpc: '2.0', id: 7, result: { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] } };
  const text = JSON.stringify(response), sse = `event: message\ndata: ${text}\n\n`;
  assert.deepEqual(parseMcpToolResponse(text, 'application/json', 7), data);
  assert.deepEqual(parseMcpToolResponse(sse, 'text/event-stream', 7), data);
  assert.throws(() => parseMcpToolResponse(text, 'application/json', 8), /identity/);
  assert.throws(() => parseMcpToolResponse(sse + sse, 'text/event-stream', 7), /duplicate/);
  assert.throws(() => parseMcpToolResponse(sse.trim(), 'text/event-stream', 7), /Incomplete/);
  const conflict = structuredClone(response); conflict.result.content[0].text = '{"memories":["wrong"]}';
  assert.throws(() => parseMcpToolResponse(JSON.stringify(conflict), 'application/json', 7), /structured results/);
});

test('host runner isolates caller keys and closes a hanging synthetic executable on abort', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-opencode-host-unit-'));
  const executable = resolve(directory, 'synthetic-host.mjs'), controller = new AbortController();
  try {
    await writeFile(executable, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('started', String(process.pid));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const env = opencodeEnvironment(directory, 'synthetic-test-key', resolve(directory, 'guard.jsonl'));
    assert.equal(env.NEBIUS_API_KEY, undefined); assert.equal(env.GH_TOKEN, undefined); assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.TK_OPENCODE_API_KEY, 'synthetic-test-key'); assert.equal(env.HOME, process.env.HOME);
    const pending = runOpenCodeHost({ root: resolve(import.meta.dirname, '..'), directory, binary: executable, key: 'synthetic-test-key', phase: 'recall-b', endpoint: 'http://127.0.0.1:1/mcp',
      token: 'synthetic-mcp', prompt: 'Synthetic no-inference interruption fixture', signal: controller.signal });
    const pidFile = resolve(directory, 'recall-b/work/started'); let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await delay(20); }
    }
    assert(pid, 'Synthetic host did not start'); controller.abort();
    const result = await pending;
    assert(result.signal !== null || result.code !== 0); assert.throws(() => assertHostResult(result));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
});

test('aborting during private host setup never starts the executable', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-opencode-setup-unit-')), controller = new AbortController();
  const executable = resolve(directory, 'synthetic-host.mjs');
  try {
    await writeFile(executable, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('unexpected-start', 'started');\n`, { mode: 0o700 });
    const pending = runOpenCodeHost({ root: resolve(import.meta.dirname, '..'), directory, binary: executable, key: 'synthetic-test-key', phase: 'recall-b', endpoint: 'http://127.0.0.1:1/mcp',
      token: 'synthetic-mcp', prompt: 'Synthetic no-inference setup interruption', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(readFile(resolve(directory, 'recall-b/work/unexpected-start')), { code: 'ENOENT' });
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt provider log preserves valid prior safe observations and fails acceptance', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-opencode-log-unit-'));
  try {
    const executable = resolve(directory, 'synthetic-host.mjs');
    await writeFile(executable, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(process.env.TK_OPENCODE_GUARD_LOG, JSON.stringify({event:'opencode_guard_ready',config_invocations:1})+'\\n'+JSON.stringify({event:'opencode_provider_request',ordinal:1,sent:true})+'\\n'+'{partial');\n`, { mode: 0o700 });
    const result = await runOpenCodeHost({ root: resolve(import.meta.dirname, '..'), directory, binary: executable, key: 'synthetic-test-key', phase: 'recall-b', endpoint: 'http://127.0.0.1:1/mcp',
      token: 'synthetic-mcp', prompt: 'Synthetic no-inference partial-log fixture', signal: new AbortController().signal });
    assert.equal(result.output_valid, false); assert.equal(result.provider.length, 2); assert.equal(result.provider[1].ordinal, 1);
    assert(result.closed && result.group_terminated); assert.throws(() => assertHostResult(result));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
