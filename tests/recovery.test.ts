import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore, DomainError } from '../packages/core/src/index.ts';
import { reconcileDeletions, exportDeletionLedger, parseDeletionLedger } from '../packages/core/src/recovery.ts';
import { prepareRecoveryState, assertRecoveryReady } from '../packages/core/src/recovery-gate.ts';
import { memoryContent } from '../packages/core/src/hashing.ts';
import { validateRestoreTarget } from '../deploy/restore.ts';
import { createTestDatabase } from './helpers.ts';
import { seedRecoveryFixture } from './recovery-fixtures.ts';
import { bootstrap } from '../apps/api/src/auth.ts';

const failure = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('a newer deletion ledger purges an older database snapshot including duplicates, revisions, jobs, vectors and export content', async () => {
  const source = await createTestDatabase({ vector: true });
  assert.ok('pglite' in source, 'Snapshot proof explicitly requires PGlite, not a native schema fixture.');
  let restored: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    const fixture = await seedRecoveryFixture(source.db);
    // The older archive can include non-content retry/lease state as well as
    // vectors. Reconciliation must purge forgotten attempts and retain a
    // surviving memory's independent retry state.
    const retryIds = [fixture.corrected.memory_ids[0], fixture.survivor.memory_ids[0]];
    await source.db.query('DELETE FROM tk_embeddings WHERE memory_id=ANY($1::text[])', [retryIds]);
    await source.db.query(`INSERT INTO tk_embedding_attempts(memory_id,revision,space_id,attempts,next_attempt_at)
      SELECT id,revision,$2,2,clock_timestamp()+interval '1 minute'
      FROM tk_memories WHERE id=ANY($1::text[])`, [retryIds, 'synthetic-recovery-space']);
    const oldSnapshot = await source.pglite.dumpDataDir();
    const ledgers = await fixture.newerLedgers();
    assert.ok(ledgers[0].tombstones.length > 0);
    assert.equal(JSON.stringify(ledgers).includes('Synthetic river'), false);
    restored = await createTestDatabase({ vector: true, snapshot: oldSnapshot });
    const report = await reconcileDeletions(restored.db, ledgers);
    assert.equal(report.deleted_memories, 4);
    assert.equal(report.deleted_sources, 6);
    assert.ok(report.deleted_jobs >= 1);
    assert.equal(report.revoked_clients, 1);
    assert.equal(report.deleted_sessions, 1);
    const store = createStore(restored.db);
    assert.deepEqual((await store.list(fixture.profile)).memories.map(row => row.id), fixture.survivor.memory_ids);
    assert.equal((await store.list(fixture.other)).memories.length, fixture.unrelated.memory_ids.length);
    for (const id of [...fixture.corrected.source_ids, ...fixture.duplicate.source_ids]) await assert.rejects(store.getSource(fixture.profile, id), failure('source_not_found'));
    const deleted = [...fixture.corrected.memory_ids, fixture.confirmed, fixture.dismissed];
    for (const table of ['tk_memories', 'tk_revisions', 'tk_evidence', 'tk_embeddings', 'tk_embedding_attempts']) {
      const column = table === 'tk_memories' ? 'id' : 'memory_id';
      assert.equal((await restored.db.query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1::text[])`, [deleted])).rows.length, 0);
    }
    assert.deepEqual((await restored.db.query('SELECT memory_id FROM tk_embedding_attempts')).rows.map(row => row.memory_id), fixture.survivor.memory_ids);
    assert.equal((await store.captureStatus(fixture.profile, fixture.duplicate.capture_id)).status, 'cancelled');
    assert.equal((await store.processJob({ extract: async () => { throw new Error('Forgotten jobs cannot call a provider'); } })), null);
    const bundle = await store.export(fixture.profile);
    assert.equal(bundle.memories.length, 1);
    assert.equal(JSON.stringify(bundle.sources).includes('Friday'), false);
    assert.equal(JSON.stringify(bundle.revisions).includes('confirms detailed'), false);
    await assert.rejects(store.capture(fixture.profile, { idempotency_key: 'synthetic-replay', project_id: 'synthetic-river', subject: 'self',
      events: [{ id: 'replayed-old-content', text: 'Synthetic river deadline is Friday. Synthetic river notes are short.', author_role: 'user', origin: 'user_explicit' }], explicit_memories: [] }), failure('deleted_source'));
  } finally { await restored?.close(); await source.close(); }
});

test('memory tombstones match superseded history and ledger coverage/freshness failures roll back without partial purge', async () => {
  const { db, close } = await createTestDatabase({ vector: true });
  try {
    const fixture = await seedRecoveryFixture(db);
    const own = await exportDeletionLedger(db, fixture.profile), other = await exportDeletionLedger(db, fixture.other);
    const originalOnly = { ...own, tombstones: [{ kind: 'memory_content' as const,
      hash: memoryContent('Synthetic river deadline is Friday.', 'synthetic-river', 'self'), deleted_at: own.exported_at }] };
    await assert.rejects(reconcileDeletions(db, [originalOnly]), failure('recovery_owner_mismatch'));
    await assert.rejects(reconcileDeletions(db, [originalOnly, { ...other, snapshot_version: 0 }]), failure('recovery_ledger_too_old'));
    assert.equal((await fixture.store.detail(fixture.profile, fixture.corrected.memory_ids[0])).memory.revision, 2);
    await reconcileDeletions(db, [originalOnly, other]);
    await assert.rejects(fixture.store.detail(fixture.profile, fixture.corrected.memory_ids[0]), failure('memory_not_found'));
    assert.equal((await fixture.store.detail(fixture.profile, fixture.confirmed)).memory.origin, 'user_confirmed');
  } finally { await close(); }
});

test('incomplete recovery stays gated and a failure after purge rolls back canonical data, credentials and completion', async () => {
  const { db, close } = await createTestDatabase({ vector: true });
  try {
    const fixture = await seedRecoveryFixture(db);
    await assertRecoveryReady(db);
    await prepareRecoveryState(db, 'a'.repeat(64), 'b'.repeat(64));
    await assert.rejects(assertRecoveryReady(db), failure('recovery_incomplete'));
    await db.query("UPDATE tk_recovery.state SET phase='restored' WHERE singleton=true");
    const own = await exportDeletionLedger(db, fixture.profile), other = await exportDeletionLedger(db, fixture.other);
    const ledger = { ...own, tombstones: [{ kind: 'memory_content' as const,
      hash: memoryContent('Synthetic river deadline is Friday.', 'synthetic-river', 'self'), deleted_at: own.exported_at }] };
    await assert.rejects(reconcileDeletions(db, [ledger, other], { completeGate: true }), failure('recovery_password_reset_required'));
    assert.equal((await fixture.store.detail(fixture.profile, fixture.corrected.memory_ids[0])).memory.revision, 2);
    assert.equal((await db.query('SELECT 1 FROM tk_clients WHERE revoked_at IS NULL')).rows.length, 1);
    assert.equal((await db.query('SELECT 1 FROM tk_sessions')).rows.length, 1);
    await assert.rejects(assertRecoveryReady(db), failure('recovery_incomplete'));
  } finally { await close(); }
});

test('restore target and deletion-ledger parsing reject accidental active targets and malformed histories', () => {
  const runtimeUrl = 'postgresql://synthetic:synthetic@localhost/threadkeeper';
  validateRestoreTarget({ targetName: 'tk_restore_synthetic', restoreUrl: 'postgresql://synthetic:synthetic@localhost/tk_restore_synthetic', runtimeUrl });
  assert.throws(() => validateRestoreTarget({ targetName: 'threadkeeper', restoreUrl: runtimeUrl, runtimeUrl }), failure('invalid_restore_target'));
  assert.throws(() => validateRestoreTarget({ targetName: 'tk_restore_other', restoreUrl: 'postgresql://synthetic:synthetic@localhost/tk_restore_wrong', runtimeUrl }), failure('invalid_restore_target'));
  const ledger = { schema_version: 'threadkeeper.deletion-ledger.v1', owner_id: 'synthetic-owner', exported_at: '2026-10-03T00:00:00Z', snapshot_version: 1,
    tombstones: [{ kind: 'source_content', hash: 'a'.repeat(64), deleted_at: '2026-10-04T00:00:00Z' }] };
  assert.equal(parseDeletionLedger(ledger).tombstones.length, 1, 'Deletion dates need not precede a different installation wall clock.');
  assert.throws(() => parseDeletionLedger({ ...ledger, tombstones: [...ledger.tombstones, ...ledger.tombstones] }), failure('invalid_deletion_ledger'));
  assert.throws(() => parseDeletionLedger({ ...ledger, tombstones: [], source_text: 'Synthetic unwanted content' }), failure('invalid_deletion_ledger'));
});

test('ledger export and parse preserve future-dated imported tombstone provenance', async () => {
  const { db, close } = await createTestDatabase();
  try {
    const auth = { ownerId: 'synthetic-clock-owner', clientId: 'profile', permissions: ['*'], projects: null };
    await db.query('INSERT INTO tk_owners(id) VALUES ($1)', [auth.ownerId]);
    const future = '2099-10-03T12:00:00.000Z';
    await createStore(db).import(auth, { schema_version: 'threadkeeper.export.v1', exported_at: '2026-10-03T00:00:00.000Z',
      sources: [], memories: [], evidence: [], revisions: [], tombstones: [{ kind: 'source_content', hash: '0'.repeat(64), deleted_at: future }] });
    const ledger = await exportDeletionLedger(db, auth);
    assert.equal(parseDeletionLedger(ledger).tombstones[0].deleted_at, future);
  } finally { await close(); }
});

test('ledger export is read-only and rejects unknown operator owners', async () => {
  const { db, close } = await createTestDatabase();
  try {
    await bootstrap(db, 'empty-recovery@example.invalid', 'synthetic-empty-password');
    const id = (await db.query('SELECT id FROM tk_users')).rows[0].id;
    const auth = { ownerId: id, clientId: 'operator', permissions: ['export'], projects: null };
    const ledger = await exportDeletionLedger(db, auth);
    assert.equal(ledger.snapshot_version, 0);
    assert.deepEqual(ledger.tombstones, []);
    await assert.rejects(exportDeletionLedger(db, { ...auth, ownerId: 'synthetic-unknown-owner' }), failure('owner_not_found'));
    assert.equal((await db.query('SELECT 1 FROM tk_owners')).rows.length, 0);
    await reconcileDeletions(db, [ledger]);
    assert.equal((await db.query('SELECT id FROM tk_owners')).rows[0].id, id, 'The known restored account can receive its empty ledger without export side effects.');
  } finally { await close(); }
});
