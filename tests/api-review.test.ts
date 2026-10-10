import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestDatabase } from './helpers.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';

type DeliveredOrigin = 'user_explicit' | 'agent_reported' | 'inferred' | 'assistant_proposed';
type RecordInput = { statement: string; origin: DeliveredOrigin; source?: string };

async function startApp(t: TestContext, port = 3196) {
  const database = await createTestDatabase();
  await bootstrap(database.db, 'delivery@example.invalid', 'synthetic-password-123');
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
  const login = await request('/api/auth/login', { body: { email: 'delivery@example.invalid', password: 'synthetic-password-123' } });
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
  return { database, store, request, grant, connect };
}

async function recall(client: Client, status?: string) {
  const result = await client.callTool({ name: 'context_search', arguments: { project_id: 'atlas', ...(status ? { status } : {}) } });
  assert.equal(result.isError, undefined);
  return (result.structuredContent as any).memories as any[];
}

async function captureRecords(store: ReturnType<typeof createApp>['store'], client: Client, records: RecordInput[], extracted = false) {
  const prefix = randomUUID();
  const events = records.map((record, index) => ({
    id: `${prefix}-${index}`, text: record.source ?? record.statement,
    author_role: record.origin === 'assistant_proposed' ? 'assistant' as const : record.origin === 'agent_reported' ? 'unknown' as const : 'user' as const,
    origin: record.origin === 'inferred' ? 'user_explicit' as const : record.origin,
  }));
  const memories = records.map((record, index) => ({
    statement: record.statement, kind: 'preference' as const, origin: record.origin,
    source_event_id: events[index].id, quote: events[index].text,
  }));
  const captured = await client.callTool({ name: 'context_capture', arguments: {
    idempotency_key: prefix, project_id: 'atlas', events,
    ...(extracted ? {} : { explicit_memories: memories }),
  } });
  assert.equal(captured.isError, undefined);
  assert.equal((captured.structuredContent as any).status, extracted ? 'pending' : 'complete');
  if (extracted) {
    const result = await store.processJob({ extract: async () => ({ model: 'synthetic-delivery-model', memories }) });
    assert.equal(result?.status, 'complete');
    assert.equal(result?.accepted, records.length);
  }
  const delivered = await recall(client);
  return records.map(record => {
    const memory = delivered.find(memory => memory.statement === record.statement);
    assert(memory, `Default recall must deliver ${record.origin} immediately.`);
    return memory;
  });
}

test('all five origins reach independent MCP clients immediately and only an owner correction changes the origin', async t => {
  const { store, request, grant, connect } = await startApp(t);
  const writer = await grant('Delivery writer', ['read', 'capture']);
  const reader = await grant('Delivery reader', ['read']);
  const a = await connect('delivery-client-a', writer.token), b = await connect('delivery-client-b', reader.token);
  const direct: RecordInput[] = [
    { statement: 'I prefer synthetic Atlas summaries in plain language.', origin: 'user_explicit' },
    { statement: 'An agent reports that the synthetic Atlas owner uses a written plan.', origin: 'agent_reported' },
    { statement: 'The synthetic Atlas owner may prefer morning updates.', source: 'I read synthetic Atlas updates over breakfast.', origin: 'inferred' },
    { statement: 'An assistant suggests a synthetic Atlas weekly digest.', origin: 'assistant_proposed' },
  ];
  const directMemories = await captureRecords(store, a, direct);
  const extractedRecords: RecordInput[] = [
    { statement: 'The synthetic Atlas owner may prefer brief planning notes.', source: 'I often skim synthetic Atlas planning notes.', origin: 'inferred' },
    { statement: 'An assistant suggests synthetic Atlas planning reminders.', origin: 'assistant_proposed' },
  ];
  const extractedMemories = await captureRecords(store, a, extractedRecords, true);
  for (const client of [a, b]) {
    const current = await recall(client);
    assert.equal(current.length, 6);
    for (const [index, memory] of [...directMemories, ...extractedMemories].entries()) {
      const delivered = current.find(record => record.id === memory.id)!;
      assert.equal(delivered.origin, [...direct, ...extractedRecords][index].origin);
      assert.equal(delivered.status, 'active');
      assert.equal(delivered.revision, 1);
      assert.equal(delivered.authoritative, false, 'Delivery is not owner endorsement.');
      assert.equal(delivered.extractor, index < direct.length ? null : 'synthetic-delivery-model');
    }
    assert.deepEqual(await recall(client, 'candidate'), []);
  }
  const inference = extractedMemories[0];
  const originalSource = (await request(`/api/sources/${inference.evidence[0].source_id}`)).data;
  const correctedText = 'I prefer detailed synthetic Atlas planning notes.';
  const corrected = await request(`/api/memories/${inference.id}`, { method: 'PATCH', body: {
    expected_revision: inference.revision, statement: correctedText, kind: 'constraint', effective_at: '2026-10-20T12:00:00Z',
  } });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.data.memory.origin, 'user_confirmed');
  assert.equal(corrected.data.memory.authoritative, true);
  for (const client of [a, b]) {
    const current = await recall(client);
    assert.equal(current.length, 6);
    assert.deepEqual(new Set(current.map(memory => memory.origin)), new Set(['user_explicit', 'user_confirmed', 'agent_reported', 'inferred', 'assistant_proposed']));
    const memory = current.find(memory => memory.id === inference.id)!;
    assert.equal(memory.statement, correctedText);
    assert.equal(memory.revision, 2);
    assert.equal(memory.kind, 'constraint');
    assert.equal(memory.effective_at, '2026-10-20T12:00:00.000Z');
    assert.equal(memory.origin, 'user_confirmed');
    assert.equal(memory.status, 'active');
    assert.equal(memory.extractor, null);
    assert.equal(memory.evidence.length, 1);
    assert.equal(memory.evidence[0].origin, 'user_confirmed');
    assert.equal(memory.evidence[0].author_role, 'user');
    assert.equal(memory.evidence[0].quote, correctedText);
    assert.equal(memory.evidence[0].capture_method, 'profile_correction');
    assert.equal(memory.evidence[0].client_id, 'profile');
    assert(!current.some(memory => memory.statement === inference.statement));
    assert(current.filter(memory => memory.origin === 'assistant_proposed').every(memory => !memory.authoritative));
  }
  const detail = (await request(`/api/memories/${inference.id}`)).data;
  assert.deepEqual(detail.revisions.map((revision: any) => [revision.origin, revision.status, revision.kind]), [
    ['inferred', 'superseded', 'preference'], ['user_confirmed', 'active', 'constraint'],
  ]);
  assert.equal(detail.revisions[0].statement, inference.statement);
  assert.equal(detail.revisions[0].extractor, 'synthetic-delivery-model');
  const preserved = detail.sources.find((source: any) => source.id === originalSource.id);
  assert.deepEqual(preserved, { ...originalSource, extraction_blocked: true });
  assert.equal(detail.sources.find((source: any) => source.capture_method === 'profile_correction').text, correctedText);
});

test('owner correction enforces authorization and concurrent revisions without an approval endpoint or client-created corrected labels', async t => {
  const { database, store, request, grant, connect } = await startApp(t);
  const writer = await grant('Correction writer', ['read', 'capture']);
  const reader = await grant('Correction reader', ['read']);
  const a = await connect('correction-client-a', writer.token), b = await connect('correction-client-b', reader.token);
  const [memory] = await captureRecords(store, a, [{ statement: 'The synthetic Atlas owner may prefer narrative notes.', origin: 'inferred' }]);
  const body = { expected_revision: 1, statement: 'I prefer synthetic Atlas written plans.', kind: 'constraint' };
  for (const token of [writer.token, reader.token]) {
    const denied = await request(`/api/memories/${memory.id}`, { method: 'PATCH', token, body });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.data.error, 'profile_session_required');
  }
  assert.equal((await request(`/api/memories/${memory.id}`, { method: 'PATCH', anonymous: true, body })).response.status, 401);
  await database.db.query(`INSERT INTO tk_users(id,email,password_hash)
    SELECT 'synthetic-other-delivery-owner','other-delivery@example.invalid',password_hash FROM tk_users LIMIT 1`);
  const otherLogin = await request('/api/auth/login', { body: { email: 'other-delivery@example.invalid', password: 'synthetic-password-123' }, anonymous: true });
  assert.equal(otherLogin.response.status, 200);
  const otherCookie = otherLogin.response.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request(`/api/memories/${memory.id}`, { method: 'PATCH', cookie: otherCookie, body })).response.status, 404);
  assert.equal((await request(`/api/memories/${memory.id}`, { method: 'PATCH', body: { ...body, kind: 'invalid' } })).response.status, 400);
  const results = await Promise.all([
    request(`/api/memories/${memory.id}`, { method: 'PATCH', body }),
    request(`/api/memories/${memory.id}`, { method: 'PATCH', body: { ...body, statement: 'I prefer synthetic Atlas visual plans.' } }),
  ]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.response.status === 409)!.data.error, 'revision_conflict');
  const corrected = results.find(result => result.response.status === 200)!.data.memory;
  for (const client of [a, b]) {
    const [current] = await recall(client);
    assert.equal(current.statement, corrected.statement);
    assert.equal(current.kind, 'constraint');
    assert.equal(current.origin, 'user_confirmed');
    assert.equal(current.revision, 2);
  }
  const detail = (await request(`/api/memories/${memory.id}`)).data;
  assert.equal(detail.revisions.length, 2);
  assert.deepEqual(detail.revisions.map((revision: any) => revision.kind), ['preference', 'constraint']);
  assert.equal((await request(`/api/memories/${memory.id}/review`, { body: { action: 'confirm', expected_revision: 2 } })).response.status, 404);
  assert.equal((await request('/api/clients', { body: { name: 'No approval permission', permissions: ['review'] } })).response.status, 400);
  const tools = (await a.listTools()).tools;
  assert(!tools.some(tool => /review|confirm|dismiss/.test(tool.name)));
  const searchDescription = tools.find(tool => tool.name === 'context_search')!.description!;
  for (const label of ['You said this', 'Corrected by you', 'Reported by an agent', 'Inferred, not stated', 'From an assistant']) assert(searchDescription.includes(label));
  assert(searchDescription.includes('Every current memory follows the same delivery, correction and deletion rules'));
  assert(!searchDescription.includes('You have not accepted'));
  assert(searchDescription.includes('require no user approval'));
  assert(searchDescription.includes('You have not stated this yourself.'));
  const schema = (await request('/openapi.json', { anonymous: true })).data;
  assert.equal(schema.paths['/api/memories/{memory_id}/review'], undefined);
  assert.equal(schema.paths['/api/context/search'].get.description, searchDescription);
  assert.deepEqual(schema.paths['/api/memories/{memory_id}'].patch.requestBody.content['application/json'].schema.properties.kind.enum,
    ['fact', 'preference', 'decision', 'constraint', 'project_state']);
  const sourceText = 'A client cannot call its own saved text a profile correction.';
  for (const origin of ['user_explicit', 'user_confirmed']) {
    const forged = await request('/api/capture', { token: writer.token, body: {
      idempotency_key: `forged-correction-${origin}`, project_id: 'atlas',
      events: [{ id: `forged-source-${origin}`, text: sourceText, author_role: 'user', origin }],
      explicit_memories: [{ statement: sourceText, kind: 'fact', origin: 'user_confirmed', source_event_id: `forged-source-${origin}`, quote: sourceText }],
    } });
    assert.equal(forged.response.status, 400);
    assert.equal(forged.data.error, 'correction_required');
  }
});

test('forgetting an assistant-contributed memory stops fresh delivery to every client', async t => {
  const { store, request, grant, connect } = await startApp(t);
  const writer = await grant('Forgetting writer', ['read', 'capture']);
  const reader = await grant('Forgetting reader', ['read']);
  const a = await connect('forgetting-client-a', writer.token), b = await connect('forgetting-client-b', reader.token);
  const [suggestion, inference] = await captureRecords(store, a, [
    { statement: 'An assistant suggests synthetic Atlas evening reminders.', origin: 'assistant_proposed' },
    { statement: 'The synthetic Atlas owner may prefer morning notes.', origin: 'inferred' },
  ]);
  assert.equal((await recall(b)).length, 2);
  const preview = await request(`/api/memories/${suggestion.id}/deletion-preview`);
  assert.equal(preview.response.status, 200);
  const forgotten = await request(`/api/memories/${suggestion.id}`, { method: 'DELETE', body: {
    expected_revision: suggestion.revision, preview_hash: preview.data.preview_hash,
  } });
  assert.equal(forgotten.response.status, 200);
  for (const client of [a, b]) {
    const current = await recall(client);
    assert.equal(current.length, 1);
    const [remaining] = current;
    assert.equal(remaining.id, inference.id);
    assert.equal(remaining.origin, 'inferred');
    assert.equal(remaining.authoritative, false);
  }
  assert.equal((await request(`/api/memories/${suggestion.id}`)).response.status, 404);
  assert.equal((await request(`/api/sources/${suggestion.evidence[0].source_id}`)).response.status, 404);
});

test('legacy candidate imports become available with original origins while dismissed records stay removed and corrections retain history', async t => {
  const source = await startApp(t);
  const writer = await source.grant('Legacy export writer', ['read', 'capture']);
  const a = await source.connect('legacy-export-client', writer.token);
  const [inference, suggestion, dismissed, reported] = await captureRecords(source.store, a, [
    { statement: 'The synthetic Atlas owner may prefer emailed summaries.', origin: 'inferred' },
    { statement: 'An assistant suggests synthetic Atlas Friday reminders.', origin: 'assistant_proposed' },
    { statement: 'The synthetic Atlas owner may prefer daily recaps.', origin: 'inferred' },
    { statement: 'An agent reports a synthetic Atlas planning constraint.', origin: 'agent_reported' },
  ], true);
  const correctedText = 'My synthetic Atlas planning constraint is one meeting per week.';
  assert.equal((await source.request(`/api/memories/${reported.id}`, { method: 'PATCH', body: {
    expected_revision: 1, statement: correctedText, kind: 'constraint',
  } })).response.status, 200);
  const exported = await source.request('/api/export');
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.schema_version, 'threadkeeper.export.v2');
  const legacy = structuredClone(exported.data);
  for (const memory of [inference, suggestion]) {
    legacy.memories.find((record: any) => record.id === memory.id).status = 'candidate';
    legacy.revisions.find((record: any) => record.memory_id === memory.id && record.revision === 1).status = 'candidate';
  }
  const dismissedMemory = legacy.memories.find((memory: any) => memory.id === dismissed.id);
  dismissedMemory.status = 'dismissed';
  dismissedMemory.revision = 2;
  const initialRevision = legacy.revisions.find((revision: any) => revision.memory_id === dismissed.id);
  legacy.revisions.push({ ...initialRevision, revision: 2, status: 'dismissed', editor_client_id: 'profile' });
  initialRevision.status = 'superseded';
  const initialEvidence = legacy.evidence.find((evidence: any) => evidence.memory_id === dismissed.id);
  legacy.evidence.push({ ...initialEvidence, revision: 2 });
  legacy.sources.find((source: any) => source.id === initialEvidence.source_id).extraction_blocked = true;
  const restored = await startApp(t, 3195);
  const imported = await restored.request('/api/import', { body: legacy });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.imported_memories, 4);
  const reader = await restored.grant('Restored independent reader', ['read']);
  const b = await restored.connect('legacy-restored-client', reader.token);
  const active = await recall(b);
  assert.equal(active.length, 3);
  for (const memory of [inference, suggestion]) {
    const current = active.find(record => record.id === memory.id)!;
    assert.equal(current.status, 'active');
    assert.equal(current.origin, memory.origin);
    assert.equal(current.revision, 1);
    assert.equal(current.authoritative, false);
    assert.equal(current.extractor, 'synthetic-delivery-model');
    const detail = (await restored.request(`/api/memories/${memory.id}`)).data;
    assert.equal(detail.revisions.length, 1);
    assert.equal(detail.revisions[0].status, 'active');
    assert.equal(detail.revisions[0].origin, memory.origin);
  }
  const correction = active.find(memory => memory.id === reported.id)!;
  assert.equal(correction.statement, correctedText);
  assert.equal(correction.origin, 'user_confirmed');
  assert.equal(correction.authoritative, true);
  assert.equal(correction.evidence[0].capture_method, 'profile_correction');
  assert.equal(correction.evidence[0].origin, 'user_confirmed');
  const correctedDetail = (await restored.request(`/api/memories/${reported.id}`)).data;
  assert.equal(correctedDetail.revisions[0].origin, 'agent_reported');
  assert.equal(correctedDetail.revisions[0].status, 'superseded');
  assert.equal(correctedDetail.revisions[0].extractor, 'synthetic-delivery-model');
  assert(correctedDetail.sources.some((source: any) => source.text === reported.statement && source.origin === 'agent_reported'));
  assert.deepEqual(await recall(b, 'candidate'), []);
  const [removed] = await recall(b, 'dismissed');
  assert.equal(removed.id, dismissed.id);
  assert.equal(removed.origin, 'inferred');
  assert.equal(removed.authoritative, false);
  const revival = await restored.request(`/api/memories/${dismissed.id}`, { method: 'PATCH', body: {
    expected_revision: 2, statement: 'Please revive the synthetic Atlas recap.',
  } });
  assert.equal(revival.response.status, 409);
  assert.equal((await recall(b)).length, 3);
  const normalized = await restored.request('/api/export');
  assert.equal(normalized.response.status, 200);
  assert(normalized.data.memories.filter((memory: any) => [inference.id, suggestion.id].includes(memory.id)).every((memory: any) => memory.status === 'active'));
  assert.equal(normalized.data.memories.find((memory: any) => memory.id === dismissed.id).status, 'dismissed');
  const repeated = await restored.request('/api/import', { body: legacy });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.data.imported_memories, 0);
  assert.equal(repeated.data.existing_memories, 4);
  assert.equal((await restored.request('/api/clients')).data.clients.length, 1, 'Import does not restore source credentials.');
});
