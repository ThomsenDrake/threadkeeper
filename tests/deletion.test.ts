import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createStore, DomainError, type Auth } from '../packages/core/src/index.ts';
import type { CaptureInput, ExplicitMemory } from '../packages/contracts/src/index.ts';
import { DeletionPreviewSchema } from '../packages/contracts/src/index.ts';
import { createTestDatabase, seedLegacyDismissal } from './helpers.ts';
import { syntheticEmbeddings } from './hybrid-fixtures.ts';

const denied = (status: number, code: string) => (error: unknown) => error instanceof DomainError && error.status === status && error.code === code;
const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['read', 'capture', 'correct', 'delete', 'export', 'import', 'review'], projects: null });
function input(text: string, options: { pending?: boolean; statement?: string; origin?: ExplicitMemory['origin']; project?: string | null; subject?: string } = {}): CaptureInput {
  const event = randomUUID();
  return { idempotency_key: randomUUID(), project_id: options.project === undefined ? 'launch' : options.project, subject: options.subject ?? 'self',
    events: [{ id: event, text, author_role: 'user', origin: 'user_explicit' }],
    ...(options.pending ? {} : { explicit_memories: [{ statement: options.statement ?? text, kind: 'fact', source_event_id: event, quote: text, origin: options.origin ?? 'user_explicit' }] }) };
}
async function fixture(t: TestContext, vector = true) {
  const database = await createTestDatabase({ vector }); t.after(() => database.close());
  const store = createStore(database.db, vector ? { embeddings: syntheticEmbeddings() } : {});
  const profile = owner(), client = { ...profile, clientId: 'synthetic-client', permissions: ['read', 'capture'] };
  return { database, store, profile, client };
}
const ids = (records: Array<{ id: string }>) => records.map(record => record.id).sort();

test('memory preview includes siblings, inferred memories, same assertion histories, owner corrections and their vectors', async t => {
  const { database, store, profile, client } = await fixture(t, true);
  const original = 'The synthetic release deadline is 20 October.';
  const capture = input(original);
  capture.explicit_memories!.push({ statement: 'The release probably needs a checklist.', kind: 'constraint', source_event_id: capture.events[0].id, quote: original, origin: 'inferred' });
  const saved = await store.capture(client, capture);
  const duplicate = await store.capture({ ...client, clientId: 'second-client' }, input('A separate synthetic audit entry supports the deadline.', { statement: original }));
  const otherProject = await store.capture(client, input('A separate project audit entry.', { statement: original, project: 'other' }));
  const otherSubject = await store.capture(client, input('A separate subject audit entry.', { statement: original, subject: 'another-person' }));
  await store.correct(profile, saved.memory_ids[0], { expected_revision: 1, statement: 'The synthetic release deadline is 27 October.' });
  await store.processEmbeddings();
  const preview = DeletionPreviewSchema.parse(await store.previewRemoval(profile, saved.memory_ids[0]));
  assert.equal(preview.expected_revision, 2);
  assert.equal(preview.memories.length, 3);
  assert.deepEqual(ids(preview.memories), [...saved.memory_ids, ...duplicate.memory_ids].sort());
  assert.equal(preview.sources.length, 3);
  assert.equal(preview.revision_count, 4);
  assert.equal(preview.evidence_count, 4);
  assert.ok(preview.memories.some(memory => memory.origin === 'inferred' && memory.status === 'active'));
  assert.ok(preview.sources.some(source => source.capture_method === 'profile_correction'));
  const removed = await store.remove(profile, saved.memory_ids[0], { expected_revision: 2, preview_hash: preview.preview_hash });
  assert.deepEqual(removed.deleted_memory_ids, ids(preview.memories));
  assert.deepEqual(removed.deleted_source_ids, ids(preview.sources));
  assert.equal(removed.deleted_count, 3);
  for (const memory of preview.memories) assert.equal((await database.db.query('SELECT 1 FROM tk_embeddings WHERE memory_id=$1', [memory.id])).rows.length, 0);
  const exported = await store.export(profile);
  assert.deepEqual(ids(exported.memories), [...otherProject.memory_ids, ...otherSubject.memory_ids].sort());
  assert.equal(exported.evidence.length, 2);
  assert.equal(exported.revisions.length, 2);
  assert.ok(exported.tombstones.some(tombstone => tombstone.kind === 'memory_content'));
  await assert.rejects(store.capture(client, { ...capture, idempotency_key: randomUUID() }), denied(410, 'deleted_source'));
});

test('source-only preview removes queued normalized copies across projects and reports whole intersecting jobs', async t => {
  const { database, store, profile, client } = await fixture(t);
  const firstInput = input('Synthetic raw context awaiting extraction.', { pending: true });
  const secondInput = input('  SYNTHETIC raw context\nawaiting extraction.  ', { pending: true, project: 'another-project' });
  const first = await store.capture(client, firstInput);
  const second = await store.capture({ ...client, clientId: 'second-client' }, secondInput);
  const mixedInput = input(firstInput.events[0].text, { pending: true });
  mixedInput.events.push({ id: randomUUID(), text: 'Independent evidence remains after the intersecting job is removed.', author_role: 'user', origin: 'user_explicit' });
  const mixed = await store.capture({ ...client, clientId: 'third-client' }, mixedInput);
  const preview = await store.previewSourceRemoval(profile, first.source_ids[0]);
  assert.equal(preview.expected_revision, null);
  assert.equal(preview.memories.length, 0);
  assert.equal(preview.sources.length, 3);
  assert.equal(preview.jobs.length, 3);
  const mixedJob = preview.jobs.find(job => job.id === mixed.job_id)!;
  assert.equal(mixedJob.source_ids.length, 2);
  assert.equal(mixedJob.affected_source_ids.length, 1);
  const removed = await store.removeSource(profile, first.source_ids[0], { preview_hash: preview.preview_hash });
  assert.equal(removed.deleted_count, 0);
  assert.equal(removed.deleted_job_ids.length, 3);
  assert.equal((await database.db.query('SELECT 1 FROM tk_jobs WHERE owner_id=$1', [profile.ownerId])).rows.length, 0);
  for (const receipt of [first, second]) {
    const current = await store.captureStatus(profile, receipt.capture_id);
    assert.equal(current.status, 'cancelled'); assert.deepEqual(current.source_ids, []); assert.equal(current.can_retry, false);
  }
  const remaining = await store.export(profile);
  assert.equal(remaining.sources.length, 1);
  assert.equal(remaining.sources[0].text, mixedInput.events[1].text);
  await assert.rejects(store.capture(client, { ...firstInput, idempotency_key: randomUUID() }), denied(410, 'deleted_source'));
  await assert.rejects(store.capture({ ...client, clientId: 'fourth-client' }, input(secondInput.events[0].text, { pending: true })), denied(410, 'deleted_source'));
  const receipt = await store.capture(client, firstInput);
  assert.equal(receipt.replayed, true, 'Immutable receipt replay cannot recreate source content.');
  assert.deepEqual((await store.captureStatus(profile, receipt.capture_id)).source_ids, []);
});

test('a concurrent sibling makes an unchanged target revision preview stale without mutating the store', async t => {
  const { database, store, profile, client } = await fixture(t);
  const captured = input('Synthetic original source.');
  const saved = await store.capture(client, captured);
  const preview = await store.previewRemoval(profile, saved.memory_ids[0]);
  const siblingInput = { ...captured, idempotency_key: randomUUID(), explicit_memories: [{ ...captured.explicit_memories![0], statement: 'A new unseen sibling interpretation.', origin: 'inferred' as const }] };
  await store.capture(client, siblingInput);
  assert.equal((await store.detail(profile, saved.memory_ids[0])).memory.revision, preview.expected_revision);
  const before = await store.export(profile);
  await assert.rejects(store.remove(profile, saved.memory_ids[0], { expected_revision: 1, preview_hash: preview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  const after = await store.export(profile);
  for (const field of ['sources', 'memories', 'revisions', 'evidence', 'tombstones'] as const) assert.deepEqual(after[field], before[field]);
  assert.equal(Number((await database.db.query('SELECT snapshot_version FROM tk_owners WHERE id=$1', [profile.ownerId])).rows[0].snapshot_version), saved.snapshot_version + 1);
  const fresh = await store.previewRemoval(profile, saved.memory_ids[0]);
  assert.equal(fresh.memories.length, 2);
  await store.remove(profile, saved.memory_ids[0], { expected_revision: 1, preview_hash: fresh.preview_hash });
});

test('source preview rejects newly admitted extraction records but accepts unrelated owner updates', async t => {
  const { store, profile, client } = await fixture(t);
  const captured = input('Synthetic pending source.', { pending: true });
  const saved = await store.capture(client, captured);
  const preview = await store.previewSourceRemoval(profile, saved.source_ids[0]);
  await store.processJob({ extract: async () => ({ memories: [{ statement: 'The admitted synthetic interpretation.', kind: 'fact', source_event_id: captured.events[0].id, quote: captured.events[0].text, origin: 'inferred' }] }) });
  await assert.rejects(store.removeSource(profile, saved.source_ids[0], { preview_hash: preview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  const refreshed = await store.previewSourceRemoval(profile, saved.source_ids[0]);
  assert.equal(refreshed.memories.length, 1);
  await store.capture(client, input('Unrelated synthetic context remains.'));
  const current = await store.previewSourceRemoval(profile, saved.source_ids[0]);
  assert.ok(current.snapshot_version > refreshed.snapshot_version);
  assert.equal(current.preview_hash, refreshed.preview_hash);
  await store.removeSource(profile, saved.source_ids[0], { preview_hash: refreshed.preview_hash });
  assert.deepEqual((await store.search(profile, {})).memories.map(memory => memory.statement), ['Unrelated synthetic context remains.']);
});

test('the digest rechecks evidence and whole-job membership even when owner version and target revision do not change', async t => {
  const { database, store, profile, client } = await fixture(t);
  const saved = await store.capture(client, input('Synthetic evidence quote for the guarded target.'));
  const preview = await store.previewRemoval(profile, saved.memory_ids[0]);
  await database.db.query('UPDATE tk_evidence SET quote=$2 WHERE memory_id=$1', [saved.memory_ids[0], 'evidence quote']);
  const changed = await store.previewRemoval(profile, saved.memory_ids[0]);
  assert.equal(changed.snapshot_version, preview.snapshot_version);
  assert.equal(changed.expected_revision, preview.expected_revision);
  await assert.rejects(store.remove(profile, saved.memory_ids[0], { expected_revision: 1, preview_hash: preview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  const pending = await store.capture(client, input('Synthetic pending membership target.', { pending: true }));
  const unrelated = await store.capture(client, input('Synthetic retained evidence in another extraction job.', { pending: true }));
  const sourcePreview = await store.previewSourceRemoval(profile, pending.source_ids[0]);
  await database.db.query('UPDATE tk_jobs SET source_ids=$2::text[] WHERE id=$1', [pending.job_id, [...pending.source_ids, ...unrelated.source_ids]]);
  const current = await store.previewSourceRemoval(profile, pending.source_ids[0]);
  assert.equal(current.snapshot_version, sourcePreview.snapshot_version);
  assert.equal(current.jobs[0].source_ids.length, 2);
  assert.equal(current.jobs[0].affected_source_ids.length, 1);
  await assert.rejects(store.removeSource(profile, pending.source_ids[0], { preview_hash: sourcePreview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  assert.equal((await store.export(profile)).tombstones.length, 0);
});

for (const outcome of ['success', 'failure'] as const) test(`forgetting source-only evidence cancels an in-flight ${outcome} without restoring data`, async t => {
  const { store, profile, client } = await fixture(t);
  const captured = input('Synthetic in-flight source.', { pending: true });
  const saved = await store.capture(client, captured);
  const preview = await store.previewSourceRemoval(profile, saved.source_ids[0]);
  let started!: () => void, finish!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const end = new Promise<void>(resolve => { finish = resolve; });
  const processing = store.processJob({ extract: async () => {
    started(); await end;
    if (outcome === 'failure') throw new Error('Synthetic provider failure');
    return { memories: [{ statement: captured.events[0].text, kind: 'fact', source_event_id: captured.events[0].id, quote: captured.events[0].text, origin: 'user_explicit' }] };
  } });
  await start;
  const active = await store.previewSourceRemoval(profile, saved.source_ids[0]);
  assert.equal(active.jobs[0].status, 'processing');
  assert.equal(active.preview_hash, preview.preview_hash, 'An unchanged job claim does not invalidate the preview.');
  await store.removeSource(profile, saved.source_ids[0], { preview_hash: preview.preview_hash });
  finish();
  assert.equal((await processing)?.status, 'cancelled');
  const current = await store.captureStatus(profile, saved.capture_id);
  assert.equal(current.status, 'cancelled'); assert.equal(current.job, null);
  const exported = await store.export(profile);
  assert.deepEqual(exported.sources, []); assert.deepEqual(exported.memories, []); assert.deepEqual(exported.revisions, []); assert.deepEqual(exported.evidence, []);
});

test('preview hashes bind target kind/id and owner, and every deletion requires a preview', async t => {
  const { store, profile, client } = await fixture(t);
  const captured = input('Synthetic bound target.');
  captured.explicit_memories!.push({ ...captured.explicit_memories![0], statement: 'Synthetic connected sibling target.', origin: 'inferred' });
  const saved = await store.capture(client, captured);
  const memoryId = saved.memory_ids[0], sourceId = saved.source_ids[0];
  const memoryPreview = await store.previewRemoval(profile, memoryId), sourcePreview = await store.previewSourceRemoval(profile, sourceId);
  const siblingPreview = await store.previewRemoval(profile, saved.memory_ids[1]);
  assert.notEqual(memoryPreview.preview_hash, sourcePreview.preview_hash);
  assert.notEqual(memoryPreview.preview_hash, siblingPreview.preview_hash);
  await assert.rejects(store.remove(profile, memoryId, { expected_revision: 1 }), denied(400, 'invalid_input'));
  await assert.rejects(store.removeSource(profile, sourceId, {}), denied(400, 'invalid_input'));
  await assert.rejects(store.removeSource(profile, sourceId, { preview_hash: memoryPreview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  await assert.rejects(store.remove(profile, memoryId, { expected_revision: 1, preview_hash: sourcePreview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  await assert.rejects(store.remove(profile, memoryId, { expected_revision: 1, preview_hash: siblingPreview.preview_hash }), denied(409, 'deletion_preview_conflict'));
  await assert.rejects(store.previewRemoval(owner(), memoryId), denied(404, 'memory_not_found'));
  await assert.rejects(store.previewSourceRemoval(owner(), sourceId), denied(404, 'source_not_found'));
  await assert.rejects(store.previewRemoval(client, memoryId), denied(403, 'permission_denied'));
  const constrained = { ...profile, projects: ['launch'] };
  await assert.rejects(store.previewRemoval(constrained, memoryId), denied(403, 'owner_delete_required'));
  await assert.rejects(store.removeSource(constrained, sourceId, { preview_hash: sourcePreview.preview_hash }), denied(403, 'owner_delete_required'));
  await store.correct(profile, memoryId, { statement: 'Synthetic correction changes the target revision.', expected_revision: 1 });
  await assert.rejects(store.remove(profile, memoryId, { expected_revision: 1, preview_hash: memoryPreview.preview_hash }), denied(409, 'revision_conflict'));
});

test('deletion history excludes forgotten source-only content from old bundle import', async t => {
  const { store, profile, client } = await fixture(t);
  const saved = await store.capture(client, input('Synthetic backup source awaiting extraction.', { pending: true }));
  const backup = await store.export(profile);
  const preview = await store.previewSourceRemoval(profile, saved.source_ids[0]);
  await store.removeSource(profile, saved.source_ids[0], { preview_hash: preview.preview_hash });
  const deletionState = await store.export(profile);
  const restored = owner();
  await store.import(restored, deletionState);
  await store.import(restored, backup);
  assert.deepEqual((await store.export(restored)).sources, []);
});

test('an owner correction cannot recreate forgotten source-only content under a new source identity', async t => {
  const { store, profile, client } = await fixture(t);
  const forgotten = 'Synthetic source-only assertion to forget.';
  const pending = await store.capture(client, input(forgotten, { pending: true }));
  const active = await store.capture(client, input('An unrelated current synthetic assertion.'));
  const preview = await store.previewSourceRemoval(profile, pending.source_ids[0]);
  await store.removeSource(profile, pending.source_ids[0], { preview_hash: preview.preview_hash });
  await assert.rejects(store.correct(profile, active.memory_ids[0], { expected_revision: 1, statement: `  ${forgotten.toUpperCase()}  ` }), denied(410, 'deleted_source'));
  const detail = await store.detail(profile, active.memory_ids[0]);
  assert.equal(detail.memory.revision, 1);
  assert.equal(detail.sources.length, 1);
  assert.equal(detail.memory.statement, 'An unrelated current synthetic assertion.');
  assert.ok(!(await store.export(profile)).sources.some(source => source.text.toLowerCase().includes(forgotten.toLowerCase())));
});

test('forgetting includes corrected owner evidence and legacy dismissed memory histories', async t => {
  const { database, store, profile, client } = await fixture(t);
  const confirmed = await store.capture(client, input('Original synthetic confirmation evidence.', { statement: 'A synthetic inference for explicit owner confirmation.', origin: 'inferred' }));
  const dismissed = await store.capture(client, input('Independent synthetic dismissal evidence.', { statement: 'A synthetic inference the owner dismisses.', origin: 'inferred' }));
  await store.correct(profile, confirmed.memory_ids[0], { expected_revision: 1, statement: 'The owner corrected the synthetic assertion.' });
  await seedLegacyDismissal(database.db, profile.ownerId, dismissed.memory_ids[0]);
  const confirmationPreview = await store.previewSourceRemoval(profile, confirmed.source_ids[0]);
  assert.equal(confirmationPreview.memories[0].origin, 'user_confirmed');
  assert.equal(confirmationPreview.memories[0].revision, 2);
  assert.equal(confirmationPreview.revision_count, 2);
  assert.equal(confirmationPreview.sources.length, 2);
  assert.ok(confirmationPreview.sources.some(source => source.capture_method === 'profile_correction'));
  await store.removeSource(profile, confirmed.source_ids[0], { preview_hash: confirmationPreview.preview_hash });
  const dismissalPreview = await store.previewRemoval(profile, dismissed.memory_ids[0]);
  assert.equal(dismissalPreview.memories[0].status, 'dismissed');
  assert.equal(dismissalPreview.revision_count, 2);
  assert.equal(dismissalPreview.evidence_count, 2);
  await store.remove(profile, dismissed.memory_ids[0], { expected_revision: 2, preview_hash: dismissalPreview.preview_hash });
  const exported = await store.export(profile);
  assert.deepEqual(exported.sources, []); assert.deepEqual(exported.memories, []);
  assert.deepEqual(exported.revisions, []); assert.deepEqual(exported.evidence, []);
});
