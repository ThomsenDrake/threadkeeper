import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';
import { DeletionPreviewSchema } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';

test('owner HTTP previews guard every memory/source deletion while clients retain fresh scoped recall', async t => {
  const database = await createTestDatabase({ vector: true });
  await bootstrap(database.db, 'forgetting@example.invalid', 'synthetic-password-123');
  const base = 'http://127.0.0.1:3193';
  const { app } = createApp(database.db, { origin: base });
  const server = app.listen(3193, '127.0.0.1');
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await database.close(); });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { method?: string; body?: unknown; token?: string; anonymous?: boolean; cookie?: string } = {}) => {
    const response = await fetch(base + path, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : options.anonymous ? {} : { cookie: options.cookie ?? cookie }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    return { response, data: await response.json() as any };
  };
  const login = await request('/api/auth/login', { body: { email: 'forgetting@example.invalid', password: 'synthetic-password-123' } });
  cookie = login.response.headers.get('set-cookie')!.split(';')[0];
  const writer = (await request('/api/clients', { body: { name: 'Synthetic independent writer', permissions: ['read', 'capture'], projects: ['launch'] } })).data;
  const sourceText = 'Synthetic saved context awaiting extraction.';
  const capture = { idempotency_key: randomUUID(), project_id: 'launch', events: [{ id: randomUUID(), text: sourceText, author_role: 'user', origin: 'user_explicit' }] };
  const pending = (await request('/api/capture', { token: writer.token, body: capture })).data;
  const sourcePath = `/api/sources/${pending.source_ids[0]}`;
  assert.equal((await request(sourcePath + '/deletion-preview', { anonymous: true })).response.status, 401);
  assert.equal((await request(sourcePath + '/deletion-preview', { token: writer.token })).response.status, 403);
  assert.equal((await request(sourcePath, { method: 'DELETE', token: writer.token, body: { preview_hash: 'a'.repeat(64) } })).response.status, 403);
  const sourcePreview = DeletionPreviewSchema.parse((await request(sourcePath + '/deletion-preview')).data);
  assert.equal(sourcePreview.memories.length, 0);
  assert.equal(sourcePreview.jobs[0].status, 'pending');
  assert.equal((await request(sourcePath, { method: 'DELETE', body: {} })).response.status, 400);

  const admitted = (await request('/api/capture', { token: writer.token, body: { ...capture, idempotency_key: randomUUID(),
    explicit_memories: [{ statement: 'Synthetic source-backed interpretation.', kind: 'fact', source_event_id: capture.events[0].id, quote: sourceText, origin: 'inferred' }] } })).data;
  assert.equal((await request(sourcePath, { method: 'DELETE', body: { preview_hash: sourcePreview.preview_hash } })).response.status, 409);
  const memoryId = admitted.memory_ids[0], memoryPath = `/api/memories/${memoryId}`;
  const memoryPreview = DeletionPreviewSchema.parse((await request(memoryPath + '/deletion-preview')).data);
  assert.equal(memoryPreview.memories[0].status, 'active');
  assert.equal((await request(memoryPath + '/deletion-preview', { token: writer.token })).response.status, 403);
  assert.equal((await request(memoryPath, { method: 'DELETE', body: { expected_revision: 1 } })).response.status, 400);
  assert.equal((await request(sourcePath, { method: 'DELETE', body: { preview_hash: memoryPreview.preview_hash } })).response.status, 409);

  const foreignOwner = randomUUID();
  await database.db.query('INSERT INTO tk_users(id,email,password_hash) SELECT $1,$2,password_hash FROM tk_users LIMIT 1', [foreignOwner, 'another-owner@example.invalid']);
  const foreignLogin = await request('/api/auth/login', { body: { email: 'another-owner@example.invalid', password: 'synthetic-password-123' } });
  const foreignCookie = foreignLogin.response.headers.get('set-cookie')!.split(';')[0];
  for (const path of [sourcePath, memoryPath]) {
    assert.equal((await request(path + '/deletion-preview', { cookie: foreignCookie })).response.status, 404);
    assert.equal((await request(path, { method: 'DELETE', cookie: foreignCookie, body: { preview_hash: memoryPreview.preview_hash, ...(path === memoryPath ? { expected_revision: 1 } : {}) } })).response.status, 404);
  }

  const unrelatedText = 'Independent synthetic context survives forgetting.';
  await request('/api/capture', { token: writer.token, body: { idempotency_key: randomUUID(), project_id: 'launch',
    events: [{ id: 'unrelated-event', text: unrelatedText, author_role: 'user', origin: 'user_explicit' }],
    explicit_memories: [{ statement: unrelatedText, kind: 'fact', source_event_id: 'unrelated-event', quote: unrelatedText, origin: 'user_explicit' }] } });
  const removed = await request(memoryPath, { method: 'DELETE', body: { expected_revision: 1, preview_hash: memoryPreview.preview_hash } });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.data.deleted_memory_ids, [memoryId]);
  assert.equal((await request(sourcePath)).response.status, 404);
  const current = (await request(`/api/captures/${pending.capture_id}`, { token: writer.token })).data;
  assert.equal(current.status, 'cancelled'); assert.deepEqual(current.source_ids, []);
  const recall = (await request('/api/context/search?project_id=launch', { token: writer.token })).data;
  assert.deepEqual(recall.memories.map((memory: any) => memory.statement), [unrelatedText]);
  const exported = (await request('/api/export')).data;
  assert.ok(!JSON.stringify(exported).includes(sourceText));
  const replay = await request('/api/capture', { token: writer.token, body: { ...capture, idempotency_key: randomUUID() } });
  assert.equal(replay.response.status, 410);

  const freshPending = (await request('/api/capture', { token: writer.token, body: { idempotency_key: randomUUID(), project_id: 'launch',
    events: [{ id: randomUUID(), text: 'Another synthetic pending source.', author_role: 'user', origin: 'user_explicit' }] } })).data;
  const freshPath = `/api/sources/${freshPending.source_ids[0]}`;
  const freshPreview = (await request(freshPath + '/deletion-preview')).data;
  assert.equal((await request(freshPath, { method: 'DELETE', body: { preview_hash: freshPreview.preview_hash } })).response.status, 200);
  const schema = (await request('/openapi.json', { anonymous: true })).data;
  assert.ok(schema.paths['/api/memories/{memory_id}'].delete.requestBody.content['application/json'].schema.required.includes('preview_hash'));
  assert.deepEqual(schema.paths['/api/sources/{source_id}'].delete.security, [{ ownerSession: [] }]);
  assert.ok(schema.paths['/api/sources/{source_id}/deletion-preview'].get.responses['200'].content['application/json'].schema.properties.preview_hash);
});
