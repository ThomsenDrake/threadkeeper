import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestDatabase } from './helpers.ts';
import { syntheticEmbeddings } from './hybrid-fixtures.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';

const deadline = 'The Atlas deadline is 20 October 2026.';
const correctedDeadline = 'The Atlas deadline is 23 October 2026.';
const preference = 'I prefer short sentences when writing.';
const inference = 'The author may favor concise prose.';
const semanticQuery = 'milestones and composition';

function capture(statement: string, project = 'atlas', id = 'synthetic-capture') {
  return {
    idempotency_key: id, project_id: project,
    events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
    explicit_memories: [{ statement, kind: 'fact', source_event_id: id, quote: statement, origin: 'user_explicit' }],
  };
}

async function startApp(t: TestContext, vectors: Record<string, number[]>) {
  const database = await createTestDatabase({ vector: true });
  await bootstrap(database.db, 'hybrid@example.invalid', 'synthetic-password-123');
  const embeddings = syntheticEmbeddings(vectors, { dimensions: 2 });
  const base = 'http://127.0.0.1:3198';
  const { app, store, auth } = createApp(database.db, { origin: base, embeddings });
  const server = app.listen(3198, '127.0.0.1');
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.close();
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { method?: string; body?: unknown; token?: string } = {}) => {
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : cookie ? { cookie } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, data: await response.json() as any };
  };
  const login = await request('/api/auth/login', { body: { email: 'hybrid@example.invalid', password: 'synthetic-password-123' } });
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
  return { database, embeddings, store, auth, request, grant, connect };
}

async function recall(client: Client, query = semanticQuery, filters: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: 'context_search', arguments: { query, ...filters } });
  assert.equal(result.isError, undefined);
  return result.structuredContent as any;
}

const statements = (result: any) => result.memories.map((memory: any) => memory.statement).sort();

async function toolDenied(client: Client, name: string, args: Record<string, unknown>) {
  const [result] = await Promise.allSettled([client.callTool({ name, arguments: args })]);
  if (result.status === 'fulfilled') assert.equal(result.value.isError, true);
  else assert.match(String(result.reason), /not found|unknown tool|scope_denied|permission_denied|403|401|Unauthorized/i);
}

test('hybrid recall through two authenticated MCP clients reflects profile correction and deletion before and after reindexing', async t => {
  const { database, store, request, grant, connect } = await startApp(t, {
    [deadline]: [1, 0], [correctedDeadline]: [1, 0], [preference]: [0, 1],
    [inference]: [0, 1], [semanticQuery]: [1, 1],
  });
  const grantA = await grant('Client A', ['read', 'capture']);
  const grantB = await grant('Client B', ['read']);
  const a = await connect('hybrid-client-a', grantA.token);
  const b = await connect('hybrid-client-b', grantB.token);
  const captured = await a.callTool({ name: 'context_capture', arguments: {
    idempotency_key: 'hybrid-central-demo', project_id: 'atlas',
    events: [
      { id: 'deadline-v1', text: deadline, author_role: 'user', origin: 'user_explicit' },
      { id: 'writing-v1', text: preference, author_role: 'user', origin: 'user_explicit' },
    ],
    explicit_memories: [
      { statement: deadline, kind: 'project_state', source_event_id: 'deadline-v1', quote: deadline, origin: 'user_explicit' },
      { statement: preference, kind: 'preference', source_event_id: 'writing-v1', quote: preference, origin: 'user_explicit' },
      { statement: inference, kind: 'preference', source_event_id: 'writing-v1', quote: preference, origin: 'inferred' },
    ],
  } });
  assert.equal(captured.isError, undefined);
  // None of this query's words occur in the two direct statements; indexing is
  // necessary for this cross-client recall, while lexical search works already.
  assert.deepEqual(statements(await recall(b)), []);
  assert.deepEqual(statements(await recall(b, 'deadline')), [deadline]);
  assert.deepEqual(await store.processEmbeddings(), { status: 'complete', indexed: 3, skipped: 0, pending: 0, deferred: 0, retry_after_ms: 0 });
  const first = await recall(b, semanticQuery, { project_id: 'atlas' });
  assert.equal(first.coverage.retrieval, 'postgresql_hybrid');
  assert.deepEqual(statements(first), [deadline, preference, inference].sort());
  for (const memory of first.memories.filter((memory: any) => memory.origin === 'user_explicit')) {
    assert.equal(memory.origin, 'user_explicit');
    assert.equal(memory.evidence.length, 1);
    assert.equal(memory.evidence[0].quote, memory.statement);
    assert.equal(memory.evidence[0].author_role, 'user');
    assert.equal(memory.evidence[0].origin, 'user_explicit');
    assert.equal(memory.evidence[0].client_id, grantA.client.id);
  }
  const inferred = first.memories.find((memory: any) => memory.origin === 'inferred');
  assert.equal(inferred.statement, inference);
  assert.equal(inferred.evidence[0].quote, preference);
  assert.equal(inferred.evidence[0].origin, 'user_explicit');
  assert.deepEqual(statements(await recall(b, semanticQuery, { status: 'candidate' })), []);

  const dl = first.memories.find((memory: any) => memory.kind === 'project_state');
  const pref = first.memories.find((memory: any) => memory.kind === 'preference' && memory.origin === 'user_explicit');
  assert.equal((await request(`/api/memories/${dl.id}`, {
    method: 'PATCH', body: { statement: correctedDeadline, expected_revision: dl.revision },
  })).response.status, 200);
  assert.equal((await request(`/api/memories/${pref.id}`, {
    method: 'DELETE', body: { expected_revision: pref.revision, preview_hash: (await request(`/api/memories/${pref.id}/deletion-preview`)).data.preview_hash },
  })).response.status, 200);
  assert.equal(Number((await database.db.query('SELECT count(*) AS n FROM tk_embeddings')).rows[0].n), 0);

  for (const client of [a, b]) {
    // Corrected memories are immediately available lexically; obsolete vectors
    // and deleted derived memories cannot be recalled while reindex is pending.
    assert.deepEqual(statements(await recall(client, 'deadline')), [correctedDeadline]);
    assert.deepEqual(statements(await recall(client)), []);
    assert.deepEqual(statements(await recall(client, semanticQuery, { status: 'candidate' })), []);
  }
  const freshApi = await request('/api/context/search?query=deadline', { token: grantB.token });
  assert.equal(freshApi.response.status, 200);
  assert.deepEqual(statements(freshApi.data), [correctedDeadline]);
  assert.equal((await request(`/api/sources/${pref.evidence[0].source_id}`, { token: grantB.token })).response.status, 404);
  await toolDenied(b, 'context_get_source', { source_id: pref.evidence[0].source_id });
  assert.deepEqual(await store.processEmbeddings(), { status: 'complete', indexed: 1, skipped: 0, pending: 0, deferred: 0, retry_after_ms: 0 });
  for (const client of [a, b]) {
    const fresh = await recall(client);
    assert.deepEqual(statements(fresh), [correctedDeadline]);
    assert.equal(fresh.memories[0].revision, 2);
    assert.equal(fresh.memories[0].authoritative, true);
    assert.equal(fresh.memories[0].origin, 'user_confirmed');
    assert.equal(fresh.memories[0].evidence[0].quote, correctedDeadline);
    assert.equal(fresh.memories[0].evidence[0].capture_method, 'profile_correction');
  }
  const exported = JSON.stringify((await request('/api/export')).data);
  assert(!exported.includes(preference));
  assert(!exported.includes(inference));
});

test('API and MCP enforce owner, project, read/capture and revocation permissions for lexical and semantic recall', async t => {
  const secret = 'The Vault deadline is 21 October 2026.';
  const otherOwner = 'Another owner has a private deadline.';
  const { database, embeddings, store, auth, request, grant, connect } = await startApp(t, {
    [deadline]: [1, 0], [secret]: [1, 0], [otherOwner]: [1, 0], [semanticQuery]: [1, 0],
  });
  const writer = await grant('Scoped writer', ['capture'], ['atlas']);
  const reader = await grant('Scoped reader', ['read'], ['atlas']);
  const writerClient = await connect('scope-writer', writer.token);
  const readerClient = await connect('scope-reader', reader.token);
  assert.deepEqual((await writerClient.listTools()).tools.map(tool => tool.name).sort(), ['context_capture', 'context_capture_status']);
  assert.deepEqual((await readerClient.listTools()).tools.map(tool => tool.name).sort(), ['context_capture_status', 'context_get_source', 'context_search']);
  const own = await request('/api/capture', { body: capture(deadline), token: writer.token });
  assert.equal(own.response.status, 201);
  const hidden = await request('/api/capture', { body: capture(secret, 'vault', 'secret') });
  assert.equal(hidden.response.status, 201);
  // A second synthetic owner has matching semantic and lexical data. Its token
  // authenticates normally, so owner isolation is exercised through transport.
  await database.db.query(`INSERT INTO tk_users(id,email,password_hash)
    SELECT 'synthetic-other-owner','other@example.invalid',password_hash FROM tk_users LIMIT 1`);
  const otherGrant = await auth.createClient('synthetic-other-owner', 'Other owner', ['read', 'capture'], null);
  const otherClient = await connect('other-owner-client', otherGrant.token);
  assert.equal((await request('/api/capture', {
    body: capture(otherOwner, 'atlas', 'other-owner'), token: otherGrant.token,
  })).response.status, 201);
  assert.deepEqual(await store.processEmbeddings(), { status: 'complete', indexed: 3, skipped: 0, pending: 0, deferred: 0, retry_after_ms: 0 });

  for (const mode of [
    { query: 'deadline', fail: true, retrieval: 'postgresql_full_text' },
    { query: semanticQuery, fail: false, retrieval: 'postgresql_hybrid' },
  ]) {
    embeddings.fail = mode.fail;
    const url = '/api/context/search?query=' + encodeURIComponent(mode.query);
    const api = await request(url, { token: reader.token });
    assert.equal(api.response.status, 200);
    assert.equal(api.data.coverage.retrieval, mode.retrieval);
    assert.deepEqual(statements(api.data), [deadline]);
    const mcp = await recall(readerClient, mode.query);
    assert.equal(mcp.coverage.retrieval, mode.retrieval);
    assert.deepEqual(statements(mcp), [deadline]);
    assert.deepEqual(statements((await request(url, { token: otherGrant.token })).data), [otherOwner]);
    assert.deepEqual(statements(await recall(otherClient, mode.query)), [otherOwner]);

    const callsBeforeDenied = embeddings.calls.length;
    assert.equal((await request(url + '&project_id=vault', { token: reader.token })).response.status, 403);
    await toolDenied(readerClient, 'context_search', { query: mode.query, project_id: 'vault' });
    assert.equal((await request(url, { token: writer.token })).response.status, 403);
    await toolDenied(writerClient, 'context_search', { query: mode.query });
    assert.equal(embeddings.calls.length, callsBeforeDenied, 'denied requests never invoke the provider');
  }
  assert.equal((await request('/api/capture', { body: capture('Disallowed capture'), token: reader.token })).response.status, 403);
  await toolDenied(readerClient, 'context_capture', capture('Disallowed capture'));
  assert.equal((await request('/api/capture', { body: capture('Wrong project', 'vault'), token: writer.token })).response.status, 403);
  await toolDenied(writerClient, 'context_capture', capture('Wrong project', 'vault'));
  assert.equal((await request(`/api/sources/${hidden.data.source_ids[0]}`, { token: reader.token })).response.status, 404);
  await toolDenied(readerClient, 'context_get_source', { source_id: hidden.data.source_ids[0] });
  assert.equal((await request(`/api/sources/${own.data.source_ids[0]}`, { token: otherGrant.token })).response.status, 404);
  await toolDenied(otherClient, 'context_get_source', { source_id: own.data.source_ids[0] });
  assert.equal((await request(`/api/clients/${reader.client.id}`, { method: 'DELETE' })).response.status, 200);
  const callsBeforeRevoked = embeddings.calls.length;
  assert.equal((await request('/api/context/search?query=' + encodeURIComponent(semanticQuery), { token: reader.token })).response.status, 401);
  await toolDenied(readerClient, 'context_search', { query: semanticQuery });
  assert.equal(embeddings.calls.length, callsBeforeRevoked);
});
