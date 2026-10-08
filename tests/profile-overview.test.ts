import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';
import { ProfileOverviewSchema, type CaptureInput } from '../packages/contracts/src/index.ts';
import { createStore, DomainError, type Auth, type Database } from '../packages/core/src/index.ts';
import { createTestDatabase } from './helpers.ts';

const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null });
const input = (subject: string, origin: 'user_explicit' | 'inferred' = 'user_explicit', project: string | null = null): CaptureInput => {
  const id = randomUUID(); const statement = `Synthetic ${subject} context ${id}.`;
  return {
    idempotency_key: id, subject, project_id: project,
    events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
    explicit_memories: [{ statement, kind: 'fact', source_event_id: id, quote: statement, origin }],
  };
};

test('Record overview rejects non-owner permissions and restricted scopes before querying context', async () => {
  const database: Database = {
    async query() { throw new Error('Unauthorized overview queried the database.'); },
    async transaction() { throw new Error('Unauthorized overview opened a transaction.'); },
  };
  const store = createStore(database); const profile = owner();
  for (const auth of [{ ...profile, permissions: ['read', 'capture'] }, { ...profile, clientId: '' }]) {
    await assert.rejects(store.profileOverview(auth), error => error instanceof DomainError && error.status === 403 && error.code === 'permission_denied');
  }
  for (const projects of [[], ['atlas']]) {
    await assert.rejects(store.profileOverview({ ...profile, projects }), error => error instanceof DomainError && error.status === 403 && error.code === 'owner_overview_required');
  }
});

test('Record subject index is complete beyond a memory page and isolates owners across all projects', async t => {
  const database = await createTestDatabase(); t.after(() => database.close());
  const store = createStore(database.db); const profile = owner();
  assert.deepEqual(await store.profileOverview(profile), {
    subjects: [], total_count: 0, active_count: 0, candidate_count: 0, source_count: 0, snapshot_version: 0,
  });
  const subjects = Array.from({ length: 55 }, (_, index) => `subject-${String(index).padStart(2, '0')}`);
  for (const [index, subject] of subjects.entries()) await store.capture(profile, input(subject, 'user_explicit', index % 2 ? 'atlas' : 'private'));
  await store.capture(owner(), input('other-owner-secret'));
  const page = await store.list(profile, { limit: 50 });
  assert.equal(page.memories.length, 50); assert.equal(page.next_offset, 50);
  const overview = ProfileOverviewSchema.parse(await store.profileOverview(profile));
  assert.deepEqual(overview.subjects, subjects.map(subject => ({ subject, total_count: 1, active_count: 1, candidate_count: 0 })));
  assert.equal(overview.total_count, 55); assert.equal(overview.active_count, 55);
  assert.equal(overview.candidate_count, 0); assert.equal(overview.source_count, 55);
  assert.equal(overview.snapshot_version, page.snapshot_version);
});

test('Record counts track confirmation, correction, dismissal and connected forgetting without dropping historical-only subjects', async t => {
  const database = await createTestDatabase(); t.after(() => database.close());
  const store = createStore(database.db); const profile = owner();
  const direct = await store.capture(profile, input('self'));
  const candidate = await store.capture(profile, input('atlas', 'inferred', 'atlas'));
  const dismissed = await store.capture(profile, input('archived', 'inferred'));
  const pending = input('pending'); delete pending.explicit_memories;
  await store.capture(profile, pending);
  const initial = await store.profileOverview(profile);
  assert.deepEqual([initial.total_count, initial.active_count, initial.candidate_count, initial.source_count], [3, 1, 2, 4]);
  assert(!initial.subjects.some(subject => subject.subject === 'pending'), 'The memory subject index does not invent a memory for unprocessed evidence.');

  await store.review(profile, candidate.memory_ids[0], { action: 'confirm', expected_revision: 1 });
  const confirmed = await store.profileOverview(profile);
  assert.deepEqual([confirmed.total_count, confirmed.active_count, confirmed.candidate_count, confirmed.source_count], [3, 2, 1, 5]);
  assert(confirmed.snapshot_version > initial.snapshot_version);
  await store.correct(profile, direct.memory_ids[0], { expected_revision: 1, statement: 'Synthetic corrected owner preference.', kind: 'preference' });
  const corrected = await store.profileOverview(profile);
  assert.deepEqual([corrected.total_count, corrected.active_count, corrected.candidate_count, corrected.source_count], [3, 2, 1, 6]);
  assert(corrected.snapshot_version > confirmed.snapshot_version);
  await store.review(profile, dismissed.memory_ids[0], { action: 'dismiss', expected_revision: 1 });
  const afterDismissal = await store.profileOverview(profile);
  assert.deepEqual(afterDismissal.subjects.find(subject => subject.subject === 'archived'), { subject: 'archived', total_count: 1, active_count: 0, candidate_count: 0 });
  assert.equal(afterDismissal.candidate_count, 0); assert.equal(afterDismissal.total_count, 3);

  const preview = await store.previewRemoval(profile, direct.memory_ids[0]);
  assert.equal(preview.sources.length, 2);
  await store.remove(profile, direct.memory_ids[0], { expected_revision: 2, preview_hash: preview.preview_hash });
  const forgotten = await store.profileOverview(profile);
  assert.deepEqual([forgotten.total_count, forgotten.active_count, forgotten.candidate_count, forgotten.source_count], [2, 1, 0, 4]);
  assert(!forgotten.subjects.some(subject => subject.subject === 'self'));
  assert(forgotten.subjects.some(subject => subject.subject === 'archived'));
  assert(forgotten.snapshot_version > afterDismissal.snapshot_version);
  const pendingSource = (await store.listCaptures(profile, {})).captures.find(capture => capture.subject === 'pending')!.source_ids[0];
  const sourcePreview = await store.previewSourceRemoval(profile, pendingSource);
  await store.removeSource(profile, pendingSource, { preview_hash: sourcePreview.preview_hash });
  const afterSourceDeletion = await store.profileOverview(profile);
  assert.equal(afterSourceDeletion.source_count, 3); assert.equal(afterSourceDeletion.total_count, 2);
});

test('Record overview HTTP endpoint requires an owner session and reflects owner mutations', async t => {
  const database = await createTestDatabase();
  await bootstrap(database.db, 'overview@example.invalid', 'synthetic-overview-password');
  const origin = 'http://127.0.0.1:3191';
  const { app } = createApp(database.db, { origin });
  const server = app.listen(3191, '127.0.0.1');
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await database.close(); });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let cookie = '';
  const request = async (path: string, options: { method?: string; body?: unknown; token?: string; anonymous?: boolean } = {}) => {
    const response = await fetch(origin + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : !options.anonymous && cookie ? { cookie } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, headers: response.headers, data: await response.json() as any };
  };
  assert.equal((await request('/api/profile/overview')).status, 401);
  const login = await request('/api/auth/login', { body: { email: 'overview@example.invalid', password: 'synthetic-overview-password' } });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const projects of [null, ['atlas']]) {
    const client = await request('/api/clients', { body: { name: 'Synthetic overview client', permissions: ['read', 'capture'], projects } });
    assert.equal(client.status, 201);
    const denied = await request('/api/profile/overview', { token: client.data.token });
    assert.equal(denied.status, 403); assert.equal(denied.data.error, 'profile_session_required');
  }
  const capture = await request('/api/capture', { body: input('atlas', 'inferred', 'atlas') });
  assert.equal(capture.status, 201); const id = capture.data.memory_ids[0];
  const initial = await request('/api/profile/overview');
  assert.equal(initial.status, 200); ProfileOverviewSchema.parse(initial.data);
  assert.deepEqual(initial.data.subjects, [{ subject: 'atlas', total_count: 1, active_count: 0, candidate_count: 1 }]);
  assert.equal((await request(`/api/memories/${id}/review`, { body: { action: 'confirm', expected_revision: 1 } })).status, 200);
  assert.equal((await request(`/api/memories/${id}`, { method: 'PATCH', body: { expected_revision: 2, statement: 'Synthetic current Atlas preference.' } })).status, 200);
  const corrected = await request('/api/profile/overview');
  assert.deepEqual([corrected.data.active_count, corrected.data.candidate_count, corrected.data.source_count], [1, 0, 3]);
  assert(corrected.data.snapshot_version > initial.data.snapshot_version);
  const preview = await request(`/api/memories/${id}/deletion-preview`);
  assert.equal((await request(`/api/memories/${id}`, { method: 'DELETE', body: { expected_revision: 3, preview_hash: preview.data.preview_hash } })).status, 200);
  const forgotten = await request('/api/profile/overview');
  assert.deepEqual(forgotten.data.subjects, []); assert.equal(forgotten.data.total_count, 0); assert.equal(forgotten.data.source_count, 0);
  const spec = (await request('/openapi.json')).data.paths['/api/profile/overview'].get;
  assert.deepEqual(spec.security, [{ ownerSession: [] }]);
  assert(spec.responses['200'].content['application/json'].schema.properties.subjects);
});
