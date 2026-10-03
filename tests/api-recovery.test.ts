import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DeletionLedgerSchema } from '../packages/contracts/src/index.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap, passwordHash } from '../apps/api/src/auth.ts';
import { prepareRecoveryState } from '../packages/core/src/recovery-gate.ts';
import { connectedDeletionRecords, applyDeletionRecords } from '../packages/core/src/deletion.ts';
import { createTestDatabase } from './helpers.ts';

async function startApp(t: TestContext) {
  const database = await createTestDatabase();
  const email = 'recovery-api@example.invalid', password = 'synthetic-recovery-api-password';
  await bootstrap(database.db, email, password);
  const base = 'http://127.0.0.1:3267';
  const { app, store, auth } = createApp(database.db, { origin: base });
  const server = app.listen(3267, '127.0.0.1');
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database.close();
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { body?: unknown; method?: string; token?: string; anonymous?: boolean; cookie?: string } = {}) => {
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : options.cookie ? { cookie: options.cookie } : !options.anonymous && cookie ? { cookie } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, data: await response.json() as any };
  };
  const login = await request('/api/auth/login', { body: { email, password }, anonymous: true });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie')!.split(';')[0];
  return { database, base, store, auth, clients, request, ownerId: login.data.user.id as string, cookie, email, password };
}

test('deletion ledger is an owner-scoped downloadable non-content artifact unavailable to anonymous users and MCP clients', async t => {
  const { database, base, clients, request, ownerId, cookie, password } = await startApp(t);
  assert.equal((await request('/api/deletion-ledger', { anonymous: true })).response.status, 401);
  const grants: { token: string; client: { id: string } }[] = [];
  for (const permissions of [['read'], ['capture'], ['read', 'capture']]) {
    const grant = await request('/api/clients', { body: { name: 'Synthetic ledger-denied client', permissions, projects: null } });
    assert.equal(grant.response.status, 201);
    grants.push(grant.data);
    assert.equal((await request('/api/deletion-ledger', { token: grant.data.token })).response.status, 403);
  }
  const mcp = new Client({ name: 'synthetic-ledger-client', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  clients.push(mcp);
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${grants[2].token}` } } }));
  assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name).sort(), ['context_capture', 'context_capture_status', 'context_get_source', 'context_search']);
  const retained = 'Synthetic private retained content is never part of a deletion ledger.';
  const forgotten = 'Synthetic private forgotten content is never part of a deletion ledger.';
  for (const [id, statement] of [['retained-ledger-event', retained], ['forgotten-ledger-event', forgotten]]) {
    const capture = await request('/api/capture', { body: {
      idempotency_key: id, events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
      explicit_memories: [{ statement, quote: statement, source_event_id: id, kind: 'fact', origin: 'user_explicit' }],
    } });
    assert.equal(capture.response.status, 201);
    if (id === 'forgotten-ledger-event') {
      await database.db.transaction(async tx => {
        await tx.query('SELECT id FROM tk_owners WHERE id=$1 FOR UPDATE', [ownerId]);
        const records = await connectedDeletionRecords(tx, ownerId, { memory_ids: capture.data.memory_ids, source_ids: [] });
        await applyDeletionRecords(tx, ownerId, records);
        await tx.query('UPDATE tk_owners SET snapshot_version=snapshot_version+1 WHERE id=$1', [ownerId]);
      });
    }
  }
  const otherOwnerId = 'synthetic-other-ledger-owner', otherHash = 'f'.repeat(64);
  await database.db.query('INSERT INTO tk_users(id,email,password_hash) VALUES ($1,$2,$3)', [otherOwnerId, 'other-ledger@example.invalid', passwordHash(password)]);
  await database.db.query('INSERT INTO tk_owners(id) VALUES ($1)', [otherOwnerId]);
  await database.db.query('INSERT INTO tk_tombstones(owner_id,kind,hash) VALUES ($1,$2,$3)', [otherOwnerId, 'memory_content', otherHash]);
  const result = await request(`/api/deletion-ledger?owner_id=${otherOwnerId}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('content-disposition'), 'attachment; filename="threadkeeper-deletion-ledger.json"');
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  const ledger = DeletionLedgerSchema.parse(result.data);
  assert.deepEqual(Object.keys(ledger).sort(), ['schema_version', 'owner_id', 'exported_at', 'snapshot_version', 'tombstones'].sort());
  assert.equal(ledger.owner_id, ownerId);
  assert.equal(ledger.snapshot_version, Number((await database.db.query('SELECT snapshot_version FROM tk_owners WHERE id=$1', [ownerId])).rows[0].snapshot_version));
  assert.ok(ledger.tombstones.length > 0);
  const canonical = (await database.db.query('SELECT kind,hash,deleted_at FROM tk_tombstones WHERE owner_id=$1 ORDER BY kind,hash', [ownerId])).rows;
  assert.deepEqual(ledger.tombstones, canonical.map(row => ({ ...row, deleted_at: new Date(row.deleted_at).toISOString() })));
  for (const tombstone of ledger.tombstones) assert.deepEqual(Object.keys(tombstone).sort(), ['kind', 'hash', 'deleted_at'].sort());
  const encoded = JSON.stringify(ledger);
  for (const excluded of [retained, forgotten, password, cookie.split('=')[1], otherHash, ...grants.flatMap(grant => [grant.token, grant.client.id])]) assert.equal(encoded.includes(excluded), false);
  for (const row of (await database.db.query('SELECT password_hash FROM tk_users UNION ALL SELECT token_hash FROM tk_clients UNION ALL SELECT token_hash FROM tk_sessions')).rows) assert.equal(encoded.includes(row.password_hash), false);
  const otherLogin = await request('/api/auth/login', { anonymous: true, body: { email: 'other-ledger@example.invalid', password } });
  const otherCookie = otherLogin.response.headers.get('set-cookie')!.split(';')[0];
  const otherResult = await request('/api/deletion-ledger', { cookie: otherCookie });
  const otherLedger = DeletionLedgerSchema.parse(otherResult.data);
  assert.equal(otherLedger.owner_id, otherOwnerId);
  assert.deepEqual(otherLedger.tombstones.map(row => row.hash), [otherHash]);
});

test('pending recovery gates health, sign-in, owner exports, client HTTP and MCP until a complete marker exists', async t => {
  const { database, request, email, password } = await startApp(t);
  const grant = await request('/api/clients', { body: { name: 'Synthetic gated client', permissions: ['read'], projects: null } });
  assert.equal((await request('/health')).response.status, 200);
  assert.equal((await request('/api/deletion-ledger')).response.status, 200);
  await prepareRecoveryState(database.db, 'a'.repeat(64), 'b'.repeat(64));
  for (const phase of ['prepared', 'restored']) {
    await database.db.query('UPDATE tk_recovery.state SET phase=$1 WHERE singleton=true', [phase]);
    for (const [path, options] of [
      ['/health', { anonymous: true }],
      ['/openapi.json', { anonymous: true }],
      ['/api/auth/login', { anonymous: true, body: { email, password } }],
      ['/api/deletion-ledger', {}],
      ['/api/export', {}],
      ['/api/context/search', { token: grant.data.token }],
      ['/mcp', { token: grant.data.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } }],
    ] as const) {
      const gated = await request(path, options);
      assert.equal(gated.response.status, 503, `${phase}: ${path}`);
      assert.equal(gated.data.error, 'recovery_incomplete');
      assert.equal(gated.response.headers.get('cache-control'), 'no-store');
    }
  }
  await database.db.query("UPDATE tk_recovery.state SET phase='complete' WHERE singleton=true");
  assert.equal((await request('/health')).response.status, 200);
  assert.equal((await request('/api/deletion-ledger')).response.status, 200);
  assert.equal((await request('/api/context/search', { token: grant.data.token })).response.status, 200);
  await database.db.query('DELETE FROM tk_recovery.state');
  assert.equal((await request('/health')).response.status, 503, 'An existing marker table without its singleton fails closed.');
});
