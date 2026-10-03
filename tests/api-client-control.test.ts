import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestDatabase } from './helpers.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';
import { CaptureSettingsSchema } from '../packages/contracts/src/index.ts';

async function start(t: TestContext) {
  const database = await createTestDatabase();
  await bootstrap(database.db, 'controls@example.invalid', 'synthetic-password-123');
  const origin = 'http://127.0.0.1:3194';
  const { app, store, auth } = createApp(database.db, { origin });
  const server = app.listen(3194, '127.0.0.1');
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.close();
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  async function request(path: string, options: { method?: string; body?: unknown; token?: string; anonymous?: boolean } = {}) {
    const response = await fetch(origin + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : !options.anonymous && cookie ? { cookie } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, data: await response.json() as any };
  }
  // Use the normal owner session but never retain a response token in evidence.
  const loginAgain = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'controls@example.invalid', password: 'synthetic-password-123' }) });
  assert.equal(loginAgain.status, 200);
  cookie = loginAgain.headers.get('set-cookie')!.split(';')[0];
  async function grant(name: string, permissions = ['read', 'capture'], projects: string[] | null = null) {
    const response = await request('/api/clients', { body: { name, permissions, projects } });
    assert.equal(response.status, 201);
    return response.data as { token: string; client: { id: string; created_at: string; last_used_at: string | null } };
  }
  async function connect(name: string, token: string) {
    const endpoint = await request('/api/settings/connection');
    assert.equal(endpoint.status, 200);
    assert.equal(endpoint.data.mcp_endpoint, origin + '/mcp');
    // The generic JSON copied by Connections feeds the SDK transport unchanged.
    const config = JSON.parse(JSON.stringify({ url: endpoint.data.mcp_endpoint, headers: { Authorization: `Bearer ${token}` } }));
    const client = new Client({ name, version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    clients.push(client);
    return client;
  }
  async function settings(paused: boolean, expected_version?: number) {
    return request('/api/settings/capture', { method: 'PATCH', body: { paused, ...(expected_version === undefined ? {} : { expected_version }) } });
  }
  return { database, store, auth, request, grant, connect, settings };
}
const explicit = (id: string, project_id: string | null, statement: string) => ({
  idempotency_key: id, project_id,
  events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
  explicit_memories: [{ statement, kind: 'fact', source_event_id: id, quote: statement, origin: 'user_explicit' }],
});
async function deniedTool(client: Client, name: string, args: Record<string, unknown>, code: RegExp) {
  const [outcome] = await Promise.allSettled([client.callTool({ name, arguments: args })]);
  if (outcome.status === 'fulfilled') {
    assert.equal(outcome.value.isError, true);
    assert.match(JSON.stringify(outcome.value.content), code);
  } else assert.match(String(outcome.reason), code);
}

test('documented connection/capture instructions work for independent MCP clients through pause, resume, scope and revocation', async t => {
  const { request, grant, connect, settings } = await start(t);
  assert.deepEqual((await request('/api/settings/capture')).data, { paused: false, version: 0 });
  const writer = await grant('Synthetic writer', ['read', 'capture'], ['atlas']);
  const reader = await grant('Independent reader', ['read'], ['atlas']);
  assert.equal(writer.client.last_used_at, null, 'Credential creation is distinct from authenticated use.');
  assert(writer.client.created_at);
  const before = await request('/api/clients');
  assert.equal(before.data.clients.find((client: any) => client.id === writer.client.id).last_used_at, null);
  const a = await connect('documented-writer', writer.token);
  const b = await connect('independent-reader', reader.token);
  const docs = await readFile(new URL('../docs/CLIENTS.md', import.meta.url), 'utf8');
  const walkthrough = docs.split('## First authorized capture and recall')[1];
  const sample = JSON.parse(walkthrough.match(/```json\n([\s\S]*?)\n```/)![1]);
  const saved = await a.callTool({ name: 'context_capture', arguments: sample });
  assert.equal(saved.isError, undefined);
  assert.equal((saved.structuredContent as any).status, 'complete');
  const recall = await b.callTool({ name: 'context_search', arguments: { query: 'short paragraphs', project_id: null } });
  assert.equal((recall.structuredContent as any).memories[0].statement, sample.explicit_memories[0].statement);
  assert.equal((recall.structuredContent as any).memories[0].origin, 'user_explicit');
  assert.equal((await request('/api/clients')).data.clients.find((client: any) => client.id === writer.client.id).last_used_at === null, false);
  const project = await request('/api/capture', { token: writer.token, body: explicit('atlas', 'atlas', 'Atlas is a synthetic project.') });
  assert.equal(project.status, 201);
  const forbidden = await request('/api/capture', { token: writer.token, body: explicit('vault', 'vault', 'A synthetic private vault record.') });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error, 'scope_denied');
  await request('/api/capture', { body: explicit('owner-vault', 'vault', 'A synthetic private vault record.') });
  const scopedRecall = await b.callTool({ name: 'context_search', arguments: {} });
  assert.deepEqual((scopedRecall.structuredContent as any).memories.map((memory: any) => memory.project_id).sort(), [null, 'atlas'].sort());
  const paused = await settings(true, 0);
  assert.equal(paused.status, 200);
  assert.deepEqual(CaptureSettingsSchema.parse(paused.data), { paused: true, version: 1 });
  for (const [token, input] of [[writer.token, sample], [undefined, explicit('profile-paused', null, 'A paused profile statement.')]] as const) {
    const blocked = await request('/api/capture', { token, body: input });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error, 'capture_paused');
  }
  await deniedTool(a, 'context_capture', explicit('paused-new', 'atlas', 'A paused MCP capture.'), /capture_paused/);
  const stillReads = await b.callTool({ name: 'context_search', arguments: { query: 'short paragraphs', project_id: null } });
  assert.equal((stillReads.structuredContent as any).memories.length, 1);
  assert.equal((await request('/api/context/search?query=paragraphs', { token: reader.token })).status, 200);
  assert.equal((await settings(false, 1)).status, 200);
  assert.equal((await request('/api/capture', { token: writer.token, body: explicit('resumed', 'atlas', 'Capture resumed for Atlas.') })).status, 201);
  const timestamp = (await request('/api/clients')).data.clients.find((client: any) => client.id === writer.client.id).last_used_at;
  assert.equal((await request(`/api/clients/${writer.client.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/api/context/search', { token: writer.token })).status, 401);
  await deniedTool(a, 'context_search', {}, /401|unauthorized/i);
  const revoked = (await request('/api/clients')).data.clients.find((client: any) => client.id === writer.client.id);
  assert(revoked.revoked_at);
  assert.equal(revoked.last_used_at, timestamp, 'Rejected revoked credentials do not record authenticated use.');
  assert.equal((await b.callTool({ name: 'context_search', arguments: { query: 'resumed' } })).isError, undefined);
});

test('owner settings are isolated, revision guarded, strictly validated and independent of memory activity', async t => {
  const { request, grant, settings, database, auth } = await start(t);
  const client = await grant('Owner controls denied');
  for (const path of ['/api/settings/capture', '/api/settings/connection']) {
    assert.equal((await request(path, { token: client.token })).status, 403);
    assert.equal((await request(path, { anonymous: true })).status, 401);
  }
  assert.equal((await request('/api/settings/capture', { method: 'PATCH', body: { paused: true }, token: client.token })).status, 403);
  assert.equal((await request('/api/clients', { token: client.token })).status, 403);
  // Even an operation denied after credential admission is an authenticated request.
  assert((await request('/api/clients')).data.clients[0].last_used_at);
  for (const body of [{}, { paused: 'true' }, { paused: true, expected_version: -1 }, { paused: true, expected_version: 0.5 }, { paused: true, extra: true }]) {
    assert.equal((await request('/api/settings/capture', { method: 'PATCH', body })).status, 400);
  }
  const results = await Promise.all([settings(true, 0), settings(true, 0)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409)!.data.error, 'capture_settings_conflict');
  assert.deepEqual((await settings(true, 1)).data, { paused: true, version: 1 }, 'A current no-op does not advance settings revision.');
  assert.equal((await settings(true, 0)).status, 409, 'Stale no-ops are still rejected.');
  assert.deepEqual((await settings(false, 1)).data, { paused: false, version: 2 });
  await request('/api/capture', { body: explicit('unrelated', null, 'A new unrelated memory.') });
  assert.deepEqual((await settings(true, 2)).data, { paused: true, version: 3 });
  await database.db.query("INSERT INTO tk_users(id,email,password_hash) SELECT 'other-controls-owner','other@example.invalid',password_hash FROM tk_users LIMIT 1");
  const other = await auth.createClient('other-controls-owner', 'Other owner', ['capture'], null);
  assert.equal((await request('/api/capture', { token: other.token, body: explicit('other', null, 'Another owner can capture while this owner is paused.') })).status, 201);
  const openapi = (await request('/openapi.json', { anonymous: true })).data;
  assert.deepEqual(openapi.paths['/api/settings/capture'].patch.security, [{ ownerSession: [] }]);
  assert.equal(openapi.paths['/api/settings/capture'].patch.requestBody.content['application/json'].schema.properties.expected_version.minimum, 0);
});

test('pause preserves already admitted queued/retried extraction and deletion fences in an in-flight job', async t => {
  const { store, request, settings } = await start(t);
  const statement = 'A synthetic queued preference.';
  const queued = await request('/api/capture', { body: { idempotency_key: 'queued', events: [{ id: 'queued', text: statement, author_role: 'user', origin: 'user_explicit' }] } });
  await settings(true, 0);
  assert.equal((await store.processJob({ extract: async () => { throw new Error('Synthetic provider failure'); } }))?.status, 'failed');
  const failed = await request(`/api/captures/${queued.data.capture_id}`);
  assert.equal(failed.data.can_retry, true);
  assert.equal((await request(`/api/captures/${queued.data.capture_id}/retry`, { body: { expected_attempts: 1 } })).status, 200);
  const candidate = { statement, kind: 'preference' as const, source_event_id: 'queued', quote: statement, origin: 'user_explicit' as const };
  assert.equal((await store.processJob({ extract: async () => ({ memories: [candidate] }) }))?.accepted, 1);
  assert.equal((await request('/api/context/search?query=queued')).data.memories.length, 1);
  await settings(false, 1);
  const fencedText = 'Synthetic evidence that will be deleted.';
  const inFlight = await request('/api/capture', { body: { idempotency_key: 'fenced', events: [{ id: 'fenced', text: fencedText, author_role: 'user', origin: 'user_explicit' }] } });
  // A separate explicit capture of the identical source creates a deletable memory.
  const sourced = await request('/api/capture', { body: { ...explicit('fenced', null, fencedText), idempotency_key: 'fenced-explicit' } });
  assert.equal(sourced.status, 201);
  let release!: () => void;
  let signal!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const worker = store.processJob({ extract: async () => { signal(); await hold; return { memories: [{ statement: fencedText, kind: 'fact', source_event_id: 'fenced', quote: fencedText, origin: 'user_explicit' }] }; } });
  await started;
  try {
    await settings(true, 2);
    const detail = await request(`/api/memories/${sourced.data.memory_ids[0]}`);
    assert.equal((await request(`/api/memories/${sourced.data.memory_ids[0]}`, { method: 'DELETE', body: { expected_revision: detail.data.memory.revision } })).status, 200);
  } finally { release(); }
  assert.equal((await worker)?.status, 'cancelled');
  const live = await request(`/api/captures/${inFlight.data.capture_id}`);
  assert.equal(live.data.status, 'cancelled');
  assert.deepEqual(live.data.memory_ids, []);
  assert.equal((await request('/api/context/search?query=deleted')).data.memories.length, 0);
});
