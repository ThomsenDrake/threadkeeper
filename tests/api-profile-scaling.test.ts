import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';
import { createTestDatabase } from './helpers.ts';

// This suite owns a port distinct from the earlier HTTP suites.
const base = 'http://127.0.0.1:3192';
test('authenticated owner browsing reaches older pages, exposes recovery guards, preserves recall limits and reports atomic import outcomes', async t => {
  const database = await createTestDatabase({ vector: true });
  await bootstrap(database.db, 'archive@example.invalid', 'synthetic-archive-password');
  const { app, store } = createApp(database.db, { origin: base });
  const server = app.listen(3192, '127.0.0.1');
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); await database.close(); });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { method?: string; body?: unknown; token?: string; raw?: string } = {}) => {
    const response = await fetch(base + path, { method: options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : { cookie }) },
      ...(options.body !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(options.body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() as any };
  };
  const login = await request('/api/auth/login', { body: { email: 'archive@example.invalid', password: 'synthetic-archive-password' } });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')!.split(';')[0];
  const ownerId = (await database.db.query('SELECT id FROM tk_users LIMIT 1')).rows[0].id;
  const principal = { ownerId, clientId: 'profile', permissions: ['*'], projects: null };
  for (let index = 0; index < 132; index++) {
    const text = `Synthetic HTTP archive ${index}.`;
    await store.capture(principal, { idempotency_key: `archive:${index}`, project_id: index % 2 ? 'atlas' : null,
      events: [{ id: `event:${index}`, text, author_role: 'user', origin: 'user_explicit' }],
      explicit_memories: [{ statement: text, kind: 'fact', source_event_id: `event:${index}`, quote: text, origin: 'user_explicit' }] });
  }
  const first = await request('/api/memories?limit=50'); assert.equal(first.status, 200); assert.equal(first.data.total_count, 132); assert.equal(first.data.next_offset, 50);
  const pageQuery = `&snapshot_version=${first.data.snapshot_version}&ranking_version=${first.data.ranking_version}`;
  const second = await request('/api/memories?limit=50&offset=50' + pageQuery);
  const third = await request('/api/memories?limit=50&offset=100' + pageQuery);
  assert.equal(second.status, 200); assert.equal(third.status, 200); assert.equal(third.data.next_offset, null);
  assert.equal(new Set([...first.data.memories, ...second.data.memories, ...third.data.memories].map(memory => memory.id)).size, 132);
  assert.equal((await request('/api/memories?project_id=atlas')).data.total_count, 66);
  for (const query of ['offset=-1', 'offset=100001', 'offset=invalid', 'limit=101', 'ranking_version=invalid', 'snapshot_version=-1', 'unknown_cursor=1']) assert.equal((await request('/api/memories?' + query)).status, 400);
  const client = await request('/api/clients', { body: { name: 'Synthetic archive reader', permissions: ['read'], projects: ['atlas'] } });
  assert.equal(client.status, 201);
  assert.equal((await request('/api/memories?offset=100', { token: client.data.token })).status, 403);
  assert.equal((await request('/api/context/search?offset=10', { token: client.data.token })).status, 400);
  assert.equal((await request('/api/context/search?limit=100', { token: client.data.token })).data.memories.length, 100);
  assert.equal((await request('/api/context/search?project_id=atlas&limit=100', { token: client.data.token })).data.memories.length, 66);
  assert.equal((await request('/api/context/search?project_id=private', { token: client.data.token })).status, 403);
  const older = third.data.memories[0];
  const correction = await request(`/api/memories/${older.id}`, { method: 'PATCH', body: { expected_revision: older.revision, statement: 'Synthetic HTTP older-page correction.' } }); assert.equal(correction.status, 200);
  const changed = await request('/api/memories?offset=50' + pageQuery); assert.equal(changed.status, 409); assert.equal(changed.data.error, 'memory_list_changed');
  const detail = await request(`/api/memories/${older.id}`); assert.equal(detail.data.sources.length, 2); assert.equal(detail.data.memory.revision, 2);
  const preview = await request(`/api/memories/${older.id}/deletion-preview`); assert.equal(preview.status, 200); assert.equal(preview.data.sources.length, 2);
  const deleted = await request(`/api/memories/${older.id}`, { method: 'DELETE', body: { expected_revision: 2, preview_hash: preview.data.preview_hash } }); assert.equal(deleted.status, 200);
  assert.equal((await request('/api/memories?query=older-page')).data.total_count, 0);
  const beforeImport = await request('/api/export');
  const imported = await request('/api/import', { body: beforeImport.data }); assert.equal(imported.status, 200);
  assert.equal(imported.data.imported_sources, 0); assert.equal(imported.data.existing_sources, 131); assert.equal(imported.data.existing_memories, 131); assert.equal(imported.data.skipped_memories, 0);
  const conflict = structuredClone(beforeImport.data); conflict.sources[0].occurred_at = '2026-09-01T00:00:00Z';
  const rejected = await request('/api/import', { body: conflict }); assert.equal(rejected.status, 409); assert.equal(rejected.data.error, 'import_source_conflict');
  const afterImport = await request('/api/export'); assert.deepEqual(afterImport.data.sources, beforeImport.data.sources); assert.deepEqual(afterImport.data.memories, beforeImport.data.memories);
  assert.equal((await request('/api/clients')).data.clients.length, 1, 'Import does not create or reactivate credentials.');
  assert.equal((await request('/api/import', { raw: JSON.stringify({ oversize: 'x'.repeat(12 * 1024 * 1024) }) })).status, 413);
  assert.equal((await request('/api/import', { body: {} })).status, 400);
  assert.equal((await request('/api/import', { body: beforeImport.data })).status, 200, 'A failed import does not prevent recovery with a valid bundle.');
  const openapi = (await request('/openapi.json')).data;
  assert.deepEqual(openapi.paths['/api/memories'].get.security, [{ ownerSession: [] }]);
  assert(openapi.paths['/api/memories'].get.parameters.some((parameter: { name: string }) => parameter.name === 'ranking_version'));
  assert(openapi.paths['/api/import'].post.responses['200'].content['application/json'].schema.properties.imported_sources);
});
