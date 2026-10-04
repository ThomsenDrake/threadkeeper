import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestDatabase } from './helpers.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';

async function startApp(t: TestContext, port = 3196) {
  const database = await createTestDatabase();
  await bootstrap(database.db, 'review@example.invalid', 'synthetic-password-123');
  const base = `http://127.0.0.1:${port}`;
  const { app, store } = createApp(database.db, { origin: base });
  const server = app.listen(port, '127.0.0.1');
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.close();
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { method?: string; body?: unknown; token?: string; cookie?: string; anonymous?: boolean } = {}) => {
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : !options.anonymous && (options.cookie ?? cookie) ? { cookie: options.cookie ?? cookie } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, data: await response.json() as any };
  };
  const login = await request('/api/auth/login', { body: { email: 'review@example.invalid', password: 'synthetic-password-123' } });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie')!.split(';')[0];
  const grant = async (name: string, permissions: string[]) => {
    const result = await request('/api/clients', { body: { name, permissions, projects: ['atlas'] } });
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
  const review = (id: string, action: 'confirm' | 'dismiss', expected_revision: number, changes: Record<string, unknown> = {}) =>
    request(`/api/memories/${id}/review`, { body: { action, expected_revision, ...changes } });
  return { database, store, request, grant, connect, review };
}

async function recall(client: Client, status?: string) {
  const result = await client.callTool({ name: 'context_search', arguments: { project_id: 'atlas', ...(status ? { status } : {}) } });
  assert.equal(result.isError, undefined);
  return (result.structuredContent as any).memories as any[];
}

async function captureCandidates(store: ReturnType<typeof createApp>['store'], client: Client, statements: string[]) {
  const captured = await client.callTool({ name: 'context_capture', arguments: {
    idempotency_key: 'synthetic-model-candidates', project_id: 'atlas',
    events: statements.map((text, index) => ({ id: `candidate-${index}`, text, author_role: 'user', origin: 'user_explicit' })),
  } });
  assert.equal(captured.isError, undefined);
  assert.equal((captured.structuredContent as any).status, 'pending');
  const extracted = await store.processJob({ extract: async ({ events }) => ({
    model: 'synthetic-review-model',
    memories: events.map(event => ({ statement: event.text, kind: 'preference', source_event_id: event.id, quote: event.text, origin: 'inferred' })),
  }) });
  assert.equal(extracted?.status, 'complete');
  return recall(client, 'candidate');
}

test('owner HTTP kind corrections and confirmations reach independent MCP clients with historical kinds intact', async t => {
  const { store, request, grant, connect, review } = await startApp(t);
  const writer = await grant('Kind writer', ['read', 'capture']);
  const reader = await grant('Kind reader', ['read']);
  const a = await connect('kind-client-a', writer.token), b = await connect('kind-client-b', reader.token);
  const statement = 'The synthetic owner prefers written planning notes.';
  const captured = await a.callTool({ name: 'context_capture', arguments: {
    idempotency_key: 'kind-active', project_id: 'atlas', events: [{ id: 'kind-active-source', text: statement, author_role: 'user', origin: 'user_explicit' }],
    explicit_memories: [{ statement, kind: 'fact', origin: 'user_explicit', source_event_id: 'kind-active-source', quote: statement }],
  } });
  assert.equal(captured.isError, undefined);
  const id = (captured.structuredContent as any).memory_ids[0];
  const body = { expected_revision: 1, statement, kind: 'preference' };
  assert.equal((await request(`/api/memories/${id}`, { method: 'PATCH', body, token: writer.token })).response.status, 403);
  assert.equal((await request(`/api/memories/${id}`, { method: 'PATCH', body: { ...body, kind: 'invalid' } })).response.status, 400);
  assert.equal((await request(`/api/memories/${id}`, { method: 'PATCH', body })).response.status, 200);
  assert.equal((await request(`/api/memories/${id}`, { method: 'PATCH', body })).response.status, 409);
  for (const client of [a, b]) {
    const current = (await recall(client)).find(memory => memory.id === id)!;
    assert.equal(current.kind, 'preference'); assert.equal(current.revision, 2);
    assert.equal(current.statement, statement); assert.equal(current.authoritative, true);
  }
  const detail = await request(`/api/memories/${id}`);
  assert.deepEqual(detail.data.revisions.map((revision: any) => revision.kind), ['fact', 'preference']);
  const [candidate] = await captureCandidates(store, a, ['Synthetic candidate describes a project constraint.']);
  assert.equal((await review(candidate.id, 'dismiss', 1, { kind: 'constraint' })).response.status, 400);
  const confirmed = await review(candidate.id, 'confirm', 1, { kind: 'constraint' });
  assert.equal(confirmed.response.status, 200);
  assert.equal((await recall(b)).find(memory => memory.id === candidate.id)!.kind, 'constraint');
  const confirmedDetail = await request(`/api/memories/${candidate.id}`);
  assert.deepEqual(confirmedDetail.data.revisions.map((revision: any) => revision.kind), ['preference', 'constraint']);
  assert.equal(confirmedDetail.data.revisions[0].extractor, 'synthetic-review-model');
  const exported = await request('/api/export');
  assert.equal(exported.data.schema_version, 'threadkeeper.export.v2');
  assert.equal((await request('/api/import', { body: exported.data })).response.status, 200);
  const schema = (await request('/openapi.json', { anonymous: true })).data;
  assert.deepEqual(schema.paths['/api/memories/{memory_id}'].patch.requestBody.content['application/json'].schema.properties.kind.enum,
    ['fact', 'preference', 'decision', 'constraint', 'project_state']);
});

test('explicit owner confirm and edit-and-confirm admit model candidates with separate user evidence through fresh independent MCP recall', async t => {
  const { store, request, grant, connect, review } = await startApp(t);
  const writer = await grant('Synthetic client A', ['read', 'capture']);
  const reader = await grant('Synthetic client B', ['read']);
  const a = await connect('review-client-a', writer.token);
  const b = await connect('review-client-b', reader.token);
  const direct = 'I prefer concise synthetic Atlas status reports.';
  const original = 'I might prefer short synthetic Atlas planning notes.';
  const edited = 'I prefer detailed synthetic Atlas planning notes.';
  const candidates = await captureCandidates(store, a, [direct, original]);
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.origin, 'inferred');
    assert.equal(candidate.extractor, 'synthetic-review-model');
    assert.equal(candidate.evidence[0].origin, 'user_explicit');
  }
  assert.deepEqual(await recall(a), []);
  assert.deepEqual(await recall(b), []);
  const queue = await request('/api/memories?status=candidate');
  assert.equal(queue.response.status, 200);
  assert.equal(queue.data.memories.length, 2);
  const first = candidates.find(candidate => candidate.statement === direct)!;
  const second = candidates.find(candidate => candidate.statement === original)!;
  const implicitCorrection = await request(`/api/memories/${first.id}`, {
    method: 'PATCH', body: { statement: direct, expected_revision: first.revision },
  });
  assert.equal(implicitCorrection.response.status, 409);
  assert.equal(implicitCorrection.data.error, 'review_required');
  const confirmed = await review(first.id, 'confirm', first.revision);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.data.memory.id, first.id);
  assert.equal(confirmed.data.memory.revision, first.revision + 1);
  assert.equal(confirmed.data.memory.statement, direct);
  assert.equal(confirmed.data.memory.status, 'active');
  assert.equal(confirmed.data.memory.origin, 'user_confirmed');
  assert.equal(confirmed.data.memory.authoritative, true);
  assert.equal(confirmed.data.memory.extractor, null);
  assert.equal((await review(first.id, 'confirm', first.revision)).response.status, 409);
  const duplicate = await review(first.id, 'confirm', confirmed.data.memory.revision);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.error, 'review_unavailable');
  const editConfirmed = await review(second.id, 'confirm', second.revision, { statement: edited, effective_at: '2026-10-20T12:00:00Z' });
  assert.equal(editConfirmed.response.status, 200);
  assert.equal(editConfirmed.data.memory.statement, edited);
  assert.equal(editConfirmed.data.memory.origin, 'user_confirmed');
  assert.equal(editConfirmed.data.memory.effective_at, '2026-10-20T12:00:00.000Z');
  for (const client of [a, b]) {
    const current = await recall(client);
    assert.deepEqual(current.map(memory => memory.statement).sort(), [direct, edited].sort());
    for (const memory of current) {
      assert.equal(memory.origin, 'user_confirmed');
      assert.equal(memory.status, 'active');
      assert.equal(memory.evidence.length, 1);
      assert.equal(memory.evidence[0].quote, memory.statement);
      assert.equal(memory.evidence[0].author_role, 'user');
      assert.equal(memory.evidence[0].origin, 'user_confirmed');
      assert.equal(memory.evidence[0].capture_method, 'profile_confirmation');
      assert.equal(memory.evidence[0].client_id, 'profile');
    }
    assert.deepEqual(await recall(client, 'candidate'), []);
  }
  assert.equal((await request('/api/memories?status=candidate')).data.memories.length, 0);
  for (const [candidate, statement] of [[first, direct], [second, edited]] as const) {
    const detail = await request(`/api/memories/${candidate.id}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.data.revisions.length, 2);
    const oldRevision = detail.data.revisions.find((revision: any) => revision.revision === candidate.revision);
    assert.equal(oldRevision.statement, candidate.statement);
    assert.equal(oldRevision.origin, 'inferred');
    assert.equal(oldRevision.status, 'superseded');
    assert.equal(oldRevision.extractor, 'synthetic-review-model');
    const originalSource = detail.data.sources.find((source: any) => source.id === candidate.evidence[0].source_id);
    assert.equal(originalSource.origin, 'user_explicit');
    assert.equal(originalSource.text, candidate.statement);
    assert.equal(originalSource.extraction_blocked, true);
    const currentEvidence = detail.data.evidence.filter((evidence: any) => evidence.revision === detail.data.memory.revision);
    assert.equal(currentEvidence.length, 1);
    assert.equal(currentEvidence[0].quote, statement);
    const currentSource = detail.data.sources.find((source: any) => source.id === currentEvidence[0].source_id);
    assert.notEqual(currentSource.id, originalSource.id);
    assert.equal(currentSource.capture_method, 'profile_confirmation');
    assert.equal(currentSource.origin, 'user_confirmed');
  }
});

test('owner dismissal excludes candidates from default recall and review queue while scoped clients and another owner cannot review them', async t => {
  const { database, store, request, grant, connect, review } = await startApp(t);
  const writer = await grant('Synthetic writer', ['read', 'capture']);
  const reader = await grant('Synthetic reader', ['read']);
  const a = await connect('dismissal-client-a', writer.token);
  const b = await connect('dismissal-client-b', reader.token);
  const [candidate] = await captureCandidates(store, a, ['I might prefer synthetic Atlas reminders.']);
  for (const token of [writer.token, reader.token]) {
    const denied = await request(`/api/memories/${candidate.id}/review`, { token, body: { action: 'confirm', expected_revision: candidate.revision } });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.data.error, 'profile_session_required');
  }
  assert(!(await a.listTools()).tools.some(tool => /review|confirm|dismiss/.test(tool.name)));
  const forbiddenPermission = await request('/api/clients', { body: { name: 'Cannot grant review', permissions: ['review'] } });
  assert.equal(forbiddenPermission.response.status, 400);
  await database.db.query(`INSERT INTO tk_users(id,email,password_hash)
    SELECT 'synthetic-other-review-owner','other-review@example.invalid',password_hash FROM tk_users LIMIT 1`);
  const otherLogin = await request('/api/auth/login', { body: { email: 'other-review@example.invalid', password: 'synthetic-password-123' }, anonymous: true });
  assert.equal(otherLogin.response.status, 200);
  const otherCookie = otherLogin.response.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request(`/api/memories/${candidate.id}/review`, {
    cookie: otherCookie, body: { action: 'confirm', expected_revision: candidate.revision },
  })).response.status, 404);
  assert.equal((await request(`/api/memories/${candidate.id}/review`, {
    anonymous: true, body: { action: 'confirm', expected_revision: candidate.revision },
  })).response.status, 401);
  for (const body of [
    {}, { action: 'accept', expected_revision: 1 }, { action: 'confirm', expected_revision: 0 },
    { action: 'confirm', expected_revision: 1, statement: '' }, { action: 'confirm', expected_revision: 1, statement: 'x'.repeat(4001) },
    { action: 'dismiss', expected_revision: 1, statement: 'An edit cannot accompany dismissal.' },
    { action: 'dismiss', expected_revision: 1, effective_at: null },
  ]) {
    assert.equal((await request(`/api/memories/${candidate.id}/review`, { body })).response.status, 400);
  }
  const dismissed = await review(candidate.id, 'dismiss', candidate.revision);
  assert.equal(dismissed.response.status, 200);
  assert.equal(dismissed.data.memory.status, 'dismissed');
  assert.equal(dismissed.data.memory.origin, 'inferred');
  assert.equal(dismissed.data.memory.authoritative, false);
  assert.equal(dismissed.data.memory.revision, candidate.revision + 1);
  assert.equal(dismissed.data.memory.extractor, 'synthetic-review-model');
  const implicitRevival = await request(`/api/memories/${candidate.id}`, {
    method: 'PATCH', body: { statement: candidate.statement, expected_revision: dismissed.data.memory.revision },
  });
  assert.equal(implicitRevival.response.status, 409);
  assert.equal(implicitRevival.data.error, 'review_required');
  for (const client of [a, b]) {
    assert.deepEqual(await recall(client), []);
    assert.deepEqual(await recall(client, 'candidate'), []);
    const dismissedRecords = await recall(client, 'dismissed');
    assert.equal(dismissedRecords.length, 1);
    assert.equal(dismissedRecords[0].id, candidate.id);
  }
  assert.deepEqual((await request('/api/memories?status=candidate')).data.memories, []);
  const stale = await review(candidate.id, 'confirm', candidate.revision);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.error, 'revision_conflict');
  for (const action of ['confirm', 'dismiss'] as const) {
    const duplicate = await review(candidate.id, action, dismissed.data.memory.revision);
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.data.error, 'review_unavailable');
  }
  assert.equal((await review('missing', 'confirm', 1)).response.status, 404);
  const schema = (await request('/openapi.json')).data.paths['/api/memories/{memory_id}/review'].post;
  assert.equal(schema.operationId, 'profile_review_memory');
  assert.deepEqual(schema.security, [{ ownerSession: [] }]);
  assert.deepEqual(schema.requestBody.content['application/json'].schema.properties.action.enum, ['confirm', 'dismiss']);
});

test('HTTP export and fresh-instance import preserve confirmation evidence, original model revisions and dismissed candidates', async t => {
  const source = await startApp(t);
  const writer = await source.grant('Export source client', ['read', 'capture']);
  const a = await source.connect('export-review-client', writer.token);
  const direct = 'I prefer synthetic Atlas summaries in plain language.';
  const inferred = 'I might prefer synthetic Atlas bullet lists.';
  const edited = 'I prefer synthetic Atlas narrative notes.';
  const candidates = await captureCandidates(source.store, a, [direct, inferred]);
  const accepted = candidates.find(candidate => candidate.statement === direct)!;
  const rejected = candidates.find(candidate => candidate.statement === inferred)!;
  const confirmed = await source.review(accepted.id, 'confirm', accepted.revision, { statement: edited });
  assert.equal(confirmed.response.status, 200);
  assert.equal((await source.review(rejected.id, 'dismiss', rejected.revision)).response.status, 200);
  const exported = await source.request('/api/export');
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.memories.find((memory: any) => memory.id === accepted.id).origin, 'user_confirmed');
  assert.equal(exported.data.memories.find((memory: any) => memory.id === rejected.id).status, 'dismissed');
  assert.equal(exported.data.revisions.find((revision: any) => revision.memory_id === accepted.id && revision.revision === 1).extractor, 'synthetic-review-model');
  assert(exported.data.sources.some((source: any) => source.capture_method === 'profile_confirmation' && source.text === edited));
  const restored = await startApp(t, 3195);
  const imported = await restored.request('/api/import', { body: exported.data });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.imported_memories, 2);
  const reader = await restored.grant('Restored recall client', ['read']);
  const b = await restored.connect('restored-review-client', reader.token);
  const active = await recall(b);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, accepted.id);
  assert.equal(active[0].statement, edited);
  assert.equal(active[0].origin, 'user_confirmed');
  assert.equal(active[0].evidence[0].capture_method, 'profile_confirmation');
  assert.equal(active[0].evidence[0].origin, 'user_confirmed');
  assert.deepEqual(await recall(b, 'candidate'), []);
  assert.equal((await recall(b, 'dismissed'))[0].id, rejected.id);
  const detail = (await restored.request(`/api/memories/${accepted.id}`)).data;
  assert.equal(detail.revisions.find((revision: any) => revision.revision === 1).origin, 'inferred');
  assert.equal(detail.revisions.find((revision: any) => revision.revision === 1).extractor, 'synthetic-review-model');
  assert(detail.sources.some((source: any) => source.text === direct && source.origin === 'user_explicit'));
  assert.equal((await restored.request('/api/clients')).data.clients.length, 1, 'Import does not restore source credentials.');
});
