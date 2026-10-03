import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CaptureStatusSchema } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';

const deadline = 'The synthetic Atlas deadline is 20 October 2026.';
const capture = (id: string, project: string | null = 'atlas', statement = deadline) => ({
  idempotency_key: id, project_id: project,
  events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
});
const memory = (id: string, statement = deadline) => ({
  statement, kind: 'project_state' as const, source_event_id: id, quote: statement, origin: 'user_explicit' as const,
});

async function startApp(t: TestContext) {
  const database = await createTestDatabase();
  await bootstrap(database.db, 'captures@example.invalid', 'synthetic-password-123');
  const base = 'http://127.0.0.1:3197';
  const { app, store, auth } = createApp(database.db, { origin: base });
  const server = app.listen(3197, '127.0.0.1');
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.close();
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { method?: string; body?: unknown; token?: string; anonymous?: boolean } = {}) => {
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : !options.anonymous && cookie ? { cookie } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, data: await response.json() as any };
  };
  const login = await request('/api/auth/login', { body: { email: 'captures@example.invalid', password: 'synthetic-password-123' } });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie')!.split(';')[0];
  const grant = async (name: string, permissions: string[], projects: string[] | null = null) => {
    const result = await request('/api/clients', { body: { name, permissions, projects } });
    assert.equal(result.response.status, 201);
    return result.data as { token: string; client: { id: string } };
  };
  const connect = async (name: string, token: string) => {
    const client = new Client({ name, version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
    return client;
  };
  const status = async (id: string, token?: string) => {
    const result = await request(`/api/captures/${id}`, { token });
    assert.equal(result.response.status, 200);
    return CaptureStatusSchema.parse(result.data);
  };
  return { database, store, auth, request, grant, connect, status };
}

async function toolStatus(client: Client, id: string) {
  const result = await client.callTool({ name: 'context_capture_status', arguments: { capture_id: id } });
  assert.equal(result.isError, undefined);
  return CaptureStatusSchema.parse(result.structuredContent);
}

async function toolDenied(client: Client, name: string, args: Record<string, unknown>) {
  const [result] = await Promise.allSettled([client.callTool({ name, arguments: args })]);
  if (result.status === 'fulfilled') assert.equal(result.value.isError, true);
  else assert.match(String(result.reason), /not found|unknown tool|scope_denied|permission_denied|403|401|Unauthorized/i);
}

test('a capture-only MCP client observes provider failure, owner retry and one successful extraction recalled by an independent client', async t => {
  const { store, request, grant, connect, status } = await startApp(t);
  const writer = await grant('Capture client A', ['capture'], ['atlas']);
  const reader = await grant('Recall client B', ['read'], ['atlas']);
  const a = await connect('capture-client-a', writer.token);
  const b = await connect('recall-client-b', reader.token);
  const input = capture('observable-deadline');
  const captured = await a.callTool({ name: 'context_capture', arguments: input });
  assert.equal(captured.isError, undefined);
  const receipt = captured.structuredContent as any;
  assert.equal(receipt.status, 'pending');
  const pending = await toolStatus(a, receipt.capture_id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.job?.attempts, 0);
  assert.equal(pending.can_retry, false);
  assert.deepEqual(pending.memory_ids, []);
  const failed = await store.processJob({ extract: async () => { throw new Error('Synthetic private provider detail must not appear in status.'); } });
  assert.equal(failed?.status, 'failed');
  const ownerFailed = await status(receipt.capture_id);
  const clientFailed = await toolStatus(a, receipt.capture_id);
  assert.equal(clientFailed.status, 'failed');
  assert.equal(clientFailed.job?.attempts, 1);
  assert.equal(clientFailed.job?.error_code, 'provider_or_validation_failed');
  assert.equal(clientFailed.can_retry, false);
  assert.equal(ownerFailed.can_retry, true);
  assert.equal(ownerFailed.retry_unavailable_reason, null);
  assert(!JSON.stringify(clientFailed).includes('Synthetic private provider detail'));
  assert.equal((await request(`/api/captures/${receipt.capture_id}/retry`, { body: { expected_attempts: 1 }, token: writer.token })).response.status, 403);
  assert.equal((await request(`/api/captures/${receipt.capture_id}/retry`, { body: { expected_attempts: 0 } })).response.status, 409);
  const retry = await request(`/api/captures/${receipt.capture_id}/retry`, { body: { expected_attempts: 1 } });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.status, 'pending');
  assert.equal(retry.data.job.id, receipt.job_id);
  assert.deepEqual(retry.data.source_ids, receipt.source_ids);
  assert.equal(retry.data.job.error_code, null);
  assert.equal(retry.data.job.completed_at, null);
  assert.equal((await request(`/api/captures/${receipt.capture_id}/retry`, { body: { expected_attempts: 1 } })).response.status, 409);

  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const processing = store.processJob({ extract: async () => { started(); await finish; return { memories: [memory('observable-deadline')], model: 'synthetic-fixture' }; } });
  await ready;
  try {
    const current = await toolStatus(a, receipt.capture_id);
    assert.equal(current.status, 'processing');
    assert.equal(current.job?.attempts, 2);
    assert(current.job?.started_at);
  } finally { release(); }
  assert.equal((await processing)?.status, 'complete');
  const completed = await toolStatus(b, receipt.capture_id);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.job?.attempts, 2);
  assert.equal(completed.job?.accepted, 1);
  assert.equal(completed.job?.skipped, 0);
  assert(completed.job?.completed_at);
  assert.deepEqual(completed.source_ids, receipt.source_ids);
  assert.equal(completed.memory_ids.length, 1);
  const recalled = await b.callTool({ name: 'context_search', arguments: { project_id: 'atlas', query: 'deadline' } });
  assert.equal(recalled.isError, undefined);
  const memories = (recalled.structuredContent as any).memories;
  assert.equal(memories.length, 1);
  assert.equal(memories[0].statement, deadline);
  assert.equal(memories[0].evidence[0].source_id, receipt.source_ids[0]);
  const replay = await a.callTool({ name: 'context_capture', arguments: input });
  assert.deepEqual(replay.structuredContent, { ...receipt, replayed: true }, 'Idempotency receipt stays stable while status follows the live job.');
  assert.equal((await status(receipt.capture_id)).status, 'complete');
  const profile = await request('/api/captures');
  assert.equal(profile.response.status, 200);
  assert.equal(profile.data.captures[0].status, 'complete');
  assert.equal(profile.data.captures[0].capture_id, receipt.capture_id);
});

test('capture status enforces owner, project and originating-client access through HTTP and MCP, including revocation', async t => {
  const { database, auth, request, grant, connect, status } = await startApp(t);
  const writer = await grant('Atlas writer', ['capture'], ['atlas']);
  const peer = await grant('Other Atlas writer', ['capture'], ['atlas']);
  const reader = await grant('Atlas reader', ['read'], ['atlas']);
  const a = await connect('scoped-capture-client', writer.token);
  const p = await connect('peer-capture-client', peer.token);
  const b = await connect('scoped-read-client', reader.token);
  assert.deepEqual((await a.listTools()).tools.map(tool => tool.name).sort(), ['context_capture', 'context_capture_status']);
  const readTools = (await b.listTools()).tools;
  assert.deepEqual(readTools.map(tool => tool.name).sort(), ['context_capture_status', 'context_get_source', 'context_search']);
  assert.equal(readTools.find(tool => tool.name === 'context_capture_status')?.annotations?.readOnlyHint, true);
  const own = await request('/api/capture', { body: capture('own'), token: writer.token });
  const peerCapture = await request('/api/capture', { body: capture('peer'), token: peer.token });
  const secret = await request('/api/capture', { body: capture('vault', 'vault', 'A synthetic vault detail.') });
  for (const result of [own, peerCapture, secret]) assert.equal(result.response.status, 201);
  assert.equal((await status(own.data.capture_id, writer.token)).status, 'pending');
  assert.equal((await toolStatus(a, own.data.capture_id)).capture_id, own.data.capture_id);
  assert.equal((await toolStatus(b, peerCapture.data.capture_id)).capture_id, peerCapture.data.capture_id);
  for (const denied of [
    { id: peerCapture.data.capture_id, token: writer.token, client: a },
    { id: own.data.capture_id, token: peer.token, client: p },
    { id: secret.data.capture_id, token: reader.token, client: b },
    { id: secret.data.capture_id, token: writer.token, client: a },
  ]) {
    assert.equal((await request(`/api/captures/${denied.id}`, { token: denied.token })).response.status, 404);
    await toolDenied(denied.client, 'context_capture_status', { capture_id: denied.id });
  }
  assert.equal((await status(secret.data.capture_id)).project_id, 'vault');
  await database.db.query(`INSERT INTO tk_users(id,email,password_hash)
    SELECT 'synthetic-other-owner','other@example.invalid',password_hash FROM tk_users LIMIT 1`);
  const other = await auth.createClient('synthetic-other-owner', 'Other owner reader', ['read'], null);
  const otherClient = await connect('other-owner-reader', other.token);
  assert.equal((await request(`/api/captures/${own.data.capture_id}`, { token: other.token })).response.status, 404);
  await toolDenied(otherClient, 'context_capture_status', { capture_id: own.data.capture_id });
  for (const token of [writer.token, reader.token, other.token]) {
    assert.equal((await request('/api/captures', { token })).response.status, 403);
    assert.equal((await request(`/api/captures/${own.data.capture_id}/retry`, { body: { expected_attempts: 0 }, token })).response.status, 403);
  }
  await toolDenied(a, 'context_capture_retry', { capture_id: own.data.capture_id, expected_attempts: 0 });
  await toolDenied(b, 'context_capture', capture('read-only-save'));
  assert.equal((await request(`/api/clients/${writer.client.id}`, { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/captures/${own.data.capture_id}`, { token: writer.token })).response.status, 401);
  await toolDenied(a, 'context_capture_status', { capture_id: own.data.capture_id });
  assert.equal((await status(own.data.capture_id)).status, 'pending');
});

test('profile capture listing paginates current states and status/retry reject malformed or unavailable actions', async t => {
  const { request, status } = await startApp(t);
  const ids: string[] = [];
  for (const id of ['first', 'second', 'third']) {
    const result = await request('/api/capture', { body: { ...capture(id), explicit_memories: [memory(id)] } });
    assert.equal(result.response.status, 201);
    ids.push(result.data.capture_id);
  }
  const first = await request('/api/captures?limit=2');
  assert.equal(first.response.status, 200);
  assert.equal(first.data.captures.length, 2);
  assert.equal(first.data.next_offset, 2);
  const second = await request(`/api/captures?limit=2&offset=${first.data.next_offset}`);
  assert.equal(second.response.status, 200);
  assert.equal(second.data.captures.length, 1);
  assert.equal(second.data.next_offset, null);
  assert.deepEqual([...first.data.captures, ...second.data.captures].map(item => item.capture_id).sort(), ids.sort());
  for (const item of [...first.data.captures, ...second.data.captures]) {
    CaptureStatusSchema.parse(item);
    assert.equal(item.job, null);
    assert.equal(item.status, 'saved');
    assert.equal(item.can_retry, false);
    assert.equal(item.memory_ids.length, 1);
  }
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=100001', 'unrecognized=true']) {
    assert.equal((await request('/api/captures?' + query)).response.status, 400);
  }
  for (const body of [{}, { expected_attempts: -1 }, { expected_attempts: 1.5 }, { expected_attempts: '1' }, { expected_attempts: 0, extra: true }]) {
    assert.equal((await request(`/api/captures/${ids[0]}/retry`, { body })).response.status, 400);
  }
  assert.equal((await request(`/api/captures/${ids[0]}/retry`, { body: { expected_attempts: 0 } })).response.status, 409);
  assert.equal((await request('/api/captures/missing')).response.status, 404);
  assert.equal((await request('/api/captures/missing/retry', { body: { expected_attempts: 0 } })).response.status, 404);
  assert.equal((await request('/api/captures', { anonymous: true })).response.status, 401);
  assert.equal((await request(`/api/captures/${ids[0]}`, { anonymous: true })).response.status, 401);
  assert.equal((await status(ids[0])).status, 'saved');
  const openapi = (await request('/openapi.json', { anonymous: true })).data;
  assert.equal(openapi.paths['/api/captures/{capture_id}'].get.operationId, 'context_capture_status');
  assert.deepEqual(openapi.paths['/api/captures/{capture_id}/retry'].post.security, [{ ownerSession: [] }]);
  assert.equal(openapi.paths['/api/captures/{capture_id}/retry'].post.requestBody.content['application/json'].schema.properties.expected_attempts.minimum, 0);
  assert(openapi.paths['/api/captures/{capture_id}'].get.responses['200'].content['application/json'].schema.properties.job);
});

test('capture status returns only live memory/source IDs after profile correction and deletion', async t => {
  const { store, request, status } = await startApp(t);
  const input = capture('live-identities');
  const pending = (await request('/api/capture', { body: input })).data;
  await store.processJob({ extract: async () => ({ memories: [memory('live-identities')] }) });
  const before = await status(pending.capture_id);
  assert.equal(before.status, 'complete');
  const detail = await request(`/api/memories/${before.memory_ids[0]}`);
  const corrected = await request(`/api/memories/${before.memory_ids[0]}`, {
    method: 'PATCH', body: { statement: 'The synthetic Atlas deadline is 23 October 2026.', expected_revision: detail.data.memory.revision },
  });
  assert.equal(corrected.response.status, 200);
  const live = await status(pending.capture_id);
  assert.deepEqual(live.memory_ids, before.memory_ids);
  assert.deepEqual(live.source_ids, before.source_ids);
  assert.equal((await request(`/api/memories/${before.memory_ids[0]}`, {
    method: 'DELETE', body: { expected_revision: corrected.data.memory.revision },
  })).response.status, 200);
  const deleted = await status(pending.capture_id);
  assert.deepEqual(deleted.source_ids, []);
  assert.deepEqual(deleted.memory_ids, []);
  assert.equal(deleted.status, 'cancelled');
  assert.equal(deleted.job, null);
  assert.equal(deleted.can_retry, false);
  assert.equal((await request(`/api/captures/${pending.capture_id}/retry`, { body: { expected_attempts: before.job!.attempts } })).response.status, 409);
});
