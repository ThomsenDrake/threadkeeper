import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createStore, DomainError, type Auth } from '../packages/core/src/index.ts';
import type { CaptureInput } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';

const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['read', 'capture', 'correct', 'delete', 'export', 'retry', 'admin'], projects: null });
const client = (profile: Auth, clientId = 'client-a', permissions = ['capture', 'read'], projects: string[] | null = null): Auth => ({ ...profile, clientId, permissions, projects });
function input(text = 'Synthetic release notes use short paragraphs.', project_id: string | null = 'launch'): CaptureInput {
  const id = randomUUID();
  return { idempotency_key: randomUUID(), project_id, subject: 'self', events: [{ id, text, author_role: 'user', origin: 'user_explicit' }] };
}
const memories = (capture: CaptureInput) => capture.events.map(event => ({ statement: event.text, kind: 'fact' as const, origin: event.origin, quote: event.text, source_event_id: event.id }));
const error = (status: number, code: string) => (cause: unknown) => cause instanceof DomainError && cause.status === status && cause.code === code;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const database = await createTestDatabase({ vector: true });
  return { ...database, store: createStore(database.db), profile: owner(), async runMigration(sql: string) {
    if ('pglite' in database) await database.pglite.exec(sql);
    else await database.db.query(sql);
  } };
}

test('failed extraction is observable, retries keep identity and increment attempts only on worker claim', async () => {
  const { db, store, profile, close } = await fixture();
  const source = input();
  try {
    const auth = client(profile);
    const receipt = await store.capture(auth, source);
    const pending = await store.captureStatus(auth, receipt.capture_id);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.job?.attempts, 0);
    assert.equal(pending.job?.accepted, null);
    await store.processJob({ extract: async () => { throw new Error('Private provider text and secret must not be saved.'); } });
    const failed = await store.captureStatus(profile, receipt.capture_id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.job?.attempts, 1);
    assert.equal(failed.job?.error_code, 'provider_or_validation_failed');
    assert.ok(failed.job?.started_at);
    assert.ok(failed.job?.completed_at);
    assert.equal(failed.can_retry, true);
    const peer = await store.captureStatus(client(profile, 'client-b', ['read']), receipt.capture_id);
    assert.equal(peer.status, 'failed');
    assert.equal(peer.can_retry, false);
    assert.equal(peer.retry_unavailable_reason, 'owner_retry_required');
    await assert.rejects(store.retryCapture(auth, receipt.capture_id, { expected_attempts: 1 }), error(403, 'permission_denied'));
    await assert.rejects(store.retryCapture(profile, receipt.capture_id, { expected_attempts: 0 }), error(409, 'attempt_conflict'));
    await assert.rejects(store.retryCapture(profile, receipt.capture_id, { expected_attempts: 1, owner_id: 'forged' }), error(400, 'invalid_input'));
    const concurrent = await Promise.allSettled([
      store.retryCapture(profile, receipt.capture_id, { expected_attempts: 1 }),
      store.retryCapture(profile, receipt.capture_id, { expected_attempts: 1 }),
    ]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(concurrent.some(result => result.status === 'rejected' && error(409, 'retry_unavailable')(result.reason)));
    const retry = await store.captureStatus(profile, receipt.capture_id);
    assert.equal(retry.status, 'pending');
    assert.equal(retry.job?.id, receipt.job_id);
    assert.equal(retry.job?.attempts, 1);
    assert.equal(retry.job?.started_at, null);
    assert.equal(retry.job?.completed_at, null);
    assert.equal(retry.job?.error_code, null);
    assert.deepEqual(retry.source_ids, receipt.source_ids);
    const started = gate(); const finish = gate();
    const processing = store.processJob({ extract: async () => { started.resolve(); await finish.promise; return { memories: memories(source) }; } });
    await started.promise;
    const active = await store.captureStatus(profile, receipt.capture_id);
    assert.equal(active.status, 'processing');
    assert.equal(active.job?.attempts, 2);
    finish.resolve();
    assert.equal((await processing)?.accepted, 1);
    const complete = await store.captureStatus(profile, receipt.capture_id);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.can_retry, false);
    assert.equal(complete.job?.accepted, 1);
    assert.equal(complete.job?.skipped, 0);
    assert.equal(complete.memory_ids.length, 1);
    assert.equal((await store.search(client(profile, 'client-b', ['read']), {})).memories[0].statement, source.events[0].text);
    assert.equal((await store.capture(auth, source)).status, 'pending', 'Idempotency replays its original receipt; status is a separate canonical read.');
    const raw = (await db.query('SELECT error_code,result FROM tk_jobs WHERE id=$1', [receipt.job_id])).rows[0];
    assert.equal(JSON.stringify(raw).includes('Private provider text'), false);
  } finally { await close(); }
});

test('saved captures, duplicate source captures and completed extraction report live canonical memory IDs', async () => {
  const { store, profile, close } = await fixture();
  try {
    const auth = client(profile);
    const source = input();
    const explicit = await store.capture(auth, { ...source, explicit_memories: memories(source) });
    const saved = await store.captureStatus(profile, explicit.capture_id);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.job, null);
    assert.equal(saved.retry_unavailable_reason, 'extraction_not_requested');
    const duplicate = await store.capture(auth, { ...source, idempotency_key: randomUUID() });
    assert.deepEqual((await store.captureStatus(profile, duplicate.capture_id)).memory_ids, explicit.memory_ids);
    const extracted = await store.processJob({ extract: async () => ({ memories: memories(source) }) });
    assert.equal(extracted?.accepted, 0);
    assert.equal(extracted?.skipped, 1);
    const status = await store.captureStatus(profile, duplicate.capture_id);
    assert.equal(status.status, 'complete');
    assert.deepEqual(status.memory_ids, explicit.memory_ids);
    await store.correct(profile, explicit.memory_ids[0], { expected_revision: 1, statement: 'Synthetic release notes now use complete paragraphs.' });
    const corrected = await store.captureStatus(profile, duplicate.capture_id);
    assert.equal(corrected.status, 'complete', 'Corrections retain the already completed extraction history.');
    assert.deepEqual(corrected.memory_ids, explicit.memory_ids, 'Current corrected records remain linked through original source history.');
    const empty = await store.capture(auth, { ...input('Synthetic source intentionally saved without extraction.'), explicit_memories: [] });
    const emptyStatus = await store.captureStatus(profile, empty.capture_id);
    assert.equal(emptyStatus.status, 'saved');
    assert.deepEqual(emptyStatus.memory_ids, []);
    assert.equal(emptyStatus.job, null);
    await store.remove(profile, explicit.memory_ids[0], { expected_revision: 2, preview_hash: (await store.previewRemoval(profile, explicit.memory_ids[0])).preview_hash });
    for (const receipt of [explicit, duplicate]) {
      const deleted = await store.captureStatus(profile, receipt.capture_id);
      assert.equal(deleted.status, 'cancelled');
      assert.deepEqual(deleted.source_ids, []);
      assert.deepEqual(deleted.memory_ids, []);
      assert.equal(deleted.job, null);
      assert.equal(deleted.can_retry, false);
    }
  } finally { await close(); }
});

test('capture status and pagination enforce owner, project and capture-only client scope', async () => {
  const { store, profile, close } = await fixture();
  try {
    const submit = async (auth: Auth, text: string, project: string | null) => store.capture(auth, { ...input(text, project), explicit_memories: [] });
    const a = client(profile);
    const launch = await submit(a, 'Synthetic launch context.', 'launch');
    const secret = await submit(a, 'Synthetic secret context.', 'secret');
    const global = await submit(a, 'Synthetic global context.', null);
    const peer = await submit(client(profile, 'client-b'), 'Synthetic peer context.', 'launch');
    const scoped = client(profile, 'reader', ['read'], ['launch']);
    assert.equal((await store.captureStatus(scoped, launch.capture_id)).status, 'saved');
    assert.equal((await store.captureStatus(scoped, global.capture_id)).status, 'saved');
    await assert.rejects(store.captureStatus(scoped, secret.capture_id), error(404, 'capture_not_found'));
    const captureOnly = client(profile, 'client-a', ['capture'], ['launch']);
    await assert.rejects(store.captureStatus(captureOnly, peer.capture_id), error(404, 'capture_not_found'));
    await assert.rejects(store.captureStatus(captureOnly, secret.capture_id), error(404, 'capture_not_found'));
    assert.equal((await store.captureStatus(captureOnly, launch.capture_id)).status, 'saved');
    await assert.rejects(store.captureStatus(owner(), launch.capture_id), error(404, 'capture_not_found'));
    await assert.rejects(store.captureStatus(client(profile, 'empty', []), launch.capture_id), error(403, 'permission_denied'));
    await assert.rejects(store.listCaptures(scoped, { limit: 0 }), error(400, 'invalid_input'));
    await assert.rejects(store.listCaptures(scoped, { offset: -1 }), error(400, 'invalid_input'));
    const page1 = await store.listCaptures(scoped, { limit: 2 });
    assert.equal(page1.captures.length, 2);
    assert.equal(page1.next_offset, 2);
    const page2 = await store.listCaptures(scoped, { limit: 2, offset: page1.next_offset });
    assert.equal(page2.captures.length, 1);
    assert.equal(page2.next_offset, null);
    assert.deepEqual(new Set([...page1.captures, ...page2.captures].map(capture => capture.capture_id)), new Set([launch.capture_id, global.capture_id, peer.capture_id]));
    assert.deepEqual(new Set((await store.listCaptures(captureOnly)).captures.map(capture => capture.capture_id)), new Set([launch.capture_id, global.capture_id]));
  } finally { await close(); }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`owner correction cancels in-flight extraction before its stale ${outcome} can restore the old source`, async () => {
    const { store, profile, close } = await fixture();
    const started = gate(); const finish = gate();
    let worker: ReturnType<typeof store.processJob> | undefined;
    try {
      const auth = client(profile); const source = input();
      const queued = await store.capture(auth, source);
      const saved = await store.capture(auth, { ...source, idempotency_key: randomUUID(), explicit_memories: memories(source) });
      worker = store.processJob({ extract: async () => {
        started.resolve(); await finish.promise;
        if (outcome === 'failure') throw new Error('Synthetic stale failure.');
        return { memories: memories(source) };
      } });
      await started.promise;
      await store.correct(profile, saved.memory_ids[0], { expected_revision: 1, statement: 'Synthetic corrected current context.' });
      const cancelled = await store.captureStatus(profile, queued.capture_id);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.job?.status, 'cancelled');
      assert.equal(cancelled.retry_unavailable_reason, 'sources_unavailable');
      assert.equal(cancelled.can_retry, false);
      assert.deepEqual(cancelled.memory_ids, saved.memory_ids);
      await assert.rejects(store.retryCapture(profile, queued.capture_id, { expected_attempts: 1 }), error(409, 'retry_unavailable'));
      finish.resolve();
      assert.equal((await worker)?.status, 'cancelled');
      assert.equal((await store.captureStatus(profile, queued.capture_id)).status, 'cancelled');
      assert.deepEqual((await store.search(profile, {})).memories.map(memory => memory.statement), ['Synthetic corrected current context.']);
    } finally { finish.resolve(); await worker; await close(); }
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`a stale extraction ${outcome} cannot overwrite an owner retry of a reclaimed failed attempt`, async () => {
    const { db, store, profile, close } = await fixture();
    const started = gate(); const finish = gate();
    let worker: ReturnType<typeof store.processJob> | undefined;
    try {
      const source = input(); const receipt = await store.capture(client(profile), source);
      worker = store.processJob({ extract: async () => {
        started.resolve(); await finish.promise;
        if (outcome === 'failure') throw new Error('Synthetic expired worker failure.');
        return { memories: memories(source) };
      } });
      await started.promise;
      await db.query("UPDATE tk_jobs SET started_at=now()-interval '11 minutes' WHERE id=$1", [receipt.job_id]);
      assert.equal((await store.processJob({ extract: async () => { throw new Error('Synthetic current attempt failure.'); } }))?.status, 'failed');
      const failed = await store.captureStatus(profile, receipt.capture_id);
      assert.equal(failed.job?.attempts, 2);
      await assert.rejects(store.retryCapture(profile, receipt.capture_id, { expected_attempts: 1 }), error(409, 'attempt_conflict'));
      await store.retryCapture(profile, receipt.capture_id, { expected_attempts: 2 });
      finish.resolve();
      assert.equal((await worker)?.status, 'cancelled');
      const pending = await store.captureStatus(profile, receipt.capture_id);
      assert.equal(pending.status, 'pending');
      assert.equal(pending.job?.attempts, 2);
      assert.equal(pending.job?.error_code, null);
      assert.deepEqual((await store.search(profile, {})).memories, []);
      assert.equal((await store.processJob({ extract: async () => ({ memories: memories(source) }) }))?.accepted, 1);
      const completed = await store.captureStatus(profile, receipt.capture_id);
      assert.equal(completed.job?.attempts, 3);
      assert.equal(completed.memory_ids.length, 1);
    } finally { finish.resolve(); await worker; await close(); }
  });
}

test('failed extraction rolls back partial admission and deletion removes retry eligibility', async () => {
  const { store, profile, close } = await fixture();
  try {
    const auth = client(profile); const source = input();
    const receipt = await store.capture(auth, source);
    await store.processJob({ extract: async () => ({ memories: [...memories(source), { ...memories(source)[0], statement: 'Invented statement.', quote: 'Invented evidence.' }] }) });
    assert.deepEqual((await store.captureStatus(profile, receipt.capture_id)).memory_ids, []);
    assert.equal((await store.captureStatus(profile, receipt.capture_id)).job?.error_code, 'evidence_mismatch');
    const explicit = await store.capture(auth, { ...source, idempotency_key: randomUUID(), explicit_memories: memories(source) });
    await store.retryCapture(profile, receipt.capture_id, { expected_attempts: 1 });
    await store.remove(profile, explicit.memory_ids[0], { expected_revision: 1, preview_hash: (await store.previewRemoval(profile, explicit.memory_ids[0])).preview_hash });
    const deleted = await store.captureStatus(profile, receipt.capture_id);
    assert.equal(deleted.status, 'cancelled');
    assert.equal(deleted.job, null);
    assert.deepEqual(deleted.source_ids, []);
    await assert.rejects(store.retryCapture(profile, receipt.capture_id, { expected_attempts: 1 }), error(409, 'retry_unavailable'));
    let called = false;
    assert.equal(await store.processJob({ extract: async () => { called = true; return { memories: memories(source) }; } }), null);
    assert.equal(called, false);
    await assert.rejects(store.capture(auth, { ...source, idempotency_key: randomUUID() }), error(410, 'deleted_source'));
    assert.equal(JSON.stringify(await store.export(profile)).includes(source.events[0].text), false);
  } finally { await close(); }
});

test('legacy capture migration backfills complete scopes and keeps unknown scopes owner-only after reruns', async () => {
  const { db, store, profile, close, runMigration } = await fixture();
  try {
    const auth = client(profile);
    const source = input();
    const receipt = await store.capture(auth, { ...source, explicit_memories: memories(source) });
    await db.query("UPDATE tk_captures SET project_id=NULL,subject=NULL,scope_known=false,source_ids='{}',job_id=NULL WHERE id=$1", [receipt.capture_id]);
    const unknownId = randomUUID();
    await db.query('INSERT INTO tk_captures(id,owner_id,client_id,idempotency_key,payload_hash,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [unknownId, profile.ownerId, auth.clientId, randomUUID(), 'legacy', JSON.stringify({ capture_id: unknownId, source_ids: ['forgotten-source'], memory_ids: [], status: 'complete' })]);
    const migration = await readFile(new URL('../deploy/migrations/004_capture_status.sql', import.meta.url), 'utf8');
    await runMigration(migration); await runMigration(migration);
    assert.equal((await store.captureStatus(auth, receipt.capture_id)).project_id, 'launch');
    const unknown = await store.captureStatus(profile, unknownId);
    assert.equal(unknown.subject, 'unknown');
    assert.equal(unknown.status, 'cancelled');
    for (const reader of [auth, client(profile, 'unrestricted', ['read']), client(profile, 'scoped', ['read'], [])]) {
      await assert.rejects(store.captureStatus(reader, unknownId), error(404, 'capture_not_found'));
      assert.equal((await store.listCaptures(reader)).captures.some(capture => capture.capture_id === unknownId), false);
    }
    assert.equal((await store.captureStatus({ ...profile, permissions: ['*'] }, unknownId)).status, 'cancelled');
    await store.remove(profile, receipt.memory_ids[0], { expected_revision: 1, preview_hash: (await store.previewRemoval(profile, receipt.memory_ids[0])).preview_hash });
    await runMigration(migration);
    assert.equal((await store.captureStatus(client(profile, 'launch-reader', ['read'], ['launch']), receipt.capture_id)).status, 'cancelled');
    await assert.rejects(store.captureStatus(client(profile, 'secret-reader', ['read'], ['secret']), receipt.capture_id), error(404, 'capture_not_found'));
  } finally { await close(); }
});
