import { DeletionLedgerSchema, type DeletionLedger } from '../../contracts/src/index.ts';
import { DomainError, type Auth, type Database } from './index.ts';
import { connectedDeletionRecords, applyDeletionRecords } from './deletion.ts';
import { sourceIdentity, sourceContent, memoryContent } from './hashing.ts';

export async function exportDeletionLedger(db: Database, auth: Auth): Promise<DeletionLedger> {
  if (!auth.ownerId || !auth.clientId || auth.projects !== null
    || !auth.permissions.some(value => ['*', 'export'].includes(value))) throw new DomainError(403, 'owner_export_required');
  return db.transaction(async tx => {
    const owner = (await tx.query('SELECT snapshot_version FROM tk_owners WHERE id=$1 FOR UPDATE', [auth.ownerId])).rows[0];
    if (!owner && !(await tx.query('SELECT id FROM tk_users WHERE id=$1', [auth.ownerId])).rows.length) throw new DomainError(404, 'owner_not_found');
    const tombstones = (await tx.query('SELECT kind,hash,deleted_at FROM tk_tombstones WHERE owner_id=$1 ORDER BY kind,hash', [auth.ownerId])).rows;
    return DeletionLedgerSchema.parse({ schema_version: 'threadkeeper.deletion-ledger.v1', owner_id: auth.ownerId,
      exported_at: new Date().toISOString(), snapshot_version: Number(owner?.snapshot_version ?? 0),
      tombstones: tombstones.map(row => ({ ...row, deleted_at: new Date(row.deleted_at).toISOString() })) });
  });
}

export function parseDeletionLedger(input: unknown): DeletionLedger {
  const parsed = DeletionLedgerSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(400, 'invalid_deletion_ledger');
  const ledger = parsed.data;
  // Dates are provenance, not a cross-clock ordering guarantee. Existing v1
  // imports may retain dates later than this installation's wall clock.
  if (new Set(ledger.tombstones.map(row => `${row.kind}:${row.hash}`)).size !== ledger.tombstones.length) throw new DomainError(400, 'invalid_deletion_ledger');
  return ledger;
}

async function matchingContent(tx: Database, ownerId: string) {
  const tombstones = (await tx.query('SELECT kind,hash FROM tk_tombstones WHERE owner_id=$1', [ownerId])).rows;
  const known = new Set(tombstones.map(row => `${row.kind}:${row.hash}`));
  const sources = (await tx.query('SELECT id,client_id,event_id,text FROM tk_sources WHERE owner_id=$1', [ownerId])).rows;
  const revisions = (await tx.query(`SELECT r.memory_id,r.statement,m.project_id,m.subject
    FROM tk_revisions r JOIN tk_memories m ON m.id=r.memory_id WHERE m.owner_id=$1
    UNION ALL SELECT id AS memory_id,statement,project_id,subject FROM tk_memories WHERE owner_id=$1`, [ownerId])).rows;
  return { source_ids: sources.filter(row => known.has(`source_identity:${sourceIdentity(row.client_id, row.event_id)}`)
    || known.has(`source_content:${sourceContent(row.text)}`)).map(row => row.id),
  memory_ids: [...new Set(revisions.filter(row => known.has(`memory_content:${memoryContent(row.statement, row.project_id, row.subject)}`)).map(row => row.memory_id))] };
}

export type ReconciliationReport = { owners: number; deleted_memories: number; deleted_sources: number; deleted_jobs: number; revoked_clients: number; deleted_sessions: number };

// Operator-only entry point. Never exposed as an online merge/import action.
// Failure rolls back all owner purges; the caller leaves its recovery gate shut.
export async function reconcileDeletions(db: Database, input: unknown[], options: { completeGate?: boolean; ownerPasswordHashes?: Record<string, string> } = {}): Promise<ReconciliationReport> {
  const ledgers = input.map(parseDeletionLedger).sort((a, b) => a.owner_id.localeCompare(b.owner_id));
  if (new Set(ledgers.map(row => row.owner_id)).size !== ledgers.length) throw new DomainError(400, 'duplicate_ledger_owner');
  return db.transaction(async tx => {
    const owners = (await tx.query('SELECT id,snapshot_version FROM tk_owners ORDER BY id FOR UPDATE')).rows;
    // Accounts without captured context still need their empty ledger and a
    // password reset, but exporting that ledger never invents canonical state.
    for (const user of (await tx.query('SELECT id FROM tk_users ORDER BY id')).rows) {
      if (!owners.some(row => row.id === user.id)) owners.push({ id: user.id, snapshot_version: 0 });
    }
    if (owners.length !== ledgers.length || owners.some(row => !ledgers.some(ledger => ledger.owner_id === row.id))) throw new DomainError(409, 'recovery_owner_mismatch');
    for (const owner of owners) {
      const ledger = ledgers.find(row => row.owner_id === owner.id)!;
      if (ledger.snapshot_version < Number(owner.snapshot_version)) throw new DomainError(409, 'recovery_ledger_too_old');
    }
    const report: ReconciliationReport = { owners: owners.length, deleted_memories: 0, deleted_sources: 0, deleted_jobs: 0, revoked_clients: 0, deleted_sessions: 0 };
    for (const ledger of ledgers) {
      await tx.query('INSERT INTO tk_owners(id) VALUES ($1) ON CONFLICT DO NOTHING', [ledger.owner_id]);
      for (const tombstone of ledger.tombstones) await tx.query(`INSERT INTO tk_tombstones(owner_id,kind,hash,deleted_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT (owner_id,kind,hash) DO UPDATE SET deleted_at=LEAST(tk_tombstones.deleted_at,excluded.deleted_at)`, [ledger.owner_id, tombstone.kind, tombstone.hash, tombstone.deleted_at]);
      const records = await connectedDeletionRecords(tx, ledger.owner_id, await matchingContent(tx, ledger.owner_id));
      const removed = await applyDeletionRecords(tx, ledger.owner_id, records);
      const remaining = await matchingContent(tx, ledger.owner_id);
      if (remaining.source_ids.length || remaining.memory_ids.length) throw new DomainError(409, 'recovery_verification_failed');
      const orphanJobs = await tx.query('SELECT id FROM tk_jobs WHERE owner_id=$1 AND source_ids && $2::text[]', [ledger.owner_id, removed.deleted_source_ids]);
      if (orphanJobs.rows.length) throw new DomainError(409, 'recovery_verification_failed');
      if ((await tx.query("SELECT to_regclass('tk_embeddings') AS relation")).rows[0]?.relation
        && (await tx.query('SELECT 1 FROM tk_embeddings WHERE memory_id=ANY($1::text[])', [removed.deleted_memory_ids])).rows.length) throw new DomainError(409, 'recovery_verification_failed');
      await tx.query('UPDATE tk_owners SET snapshot_version=GREATEST(snapshot_version,$2)+1 WHERE id=$1', [ledger.owner_id, ledger.snapshot_version]);
      report.deleted_memories += removed.deleted_memory_ids.length;
      report.deleted_sources += removed.deleted_source_ids.length;
      report.deleted_jobs += removed.deleted_job_ids.length;
    }
    report.deleted_sessions = (await tx.query('DELETE FROM tk_sessions RETURNING token_hash')).rows.length;
    report.revoked_clients = (await tx.query('UPDATE tk_clients SET revoked_at=now() WHERE revoked_at IS NULL RETURNING id')).rows.length;
    if (options.completeGate) {
      const users = (await tx.query('SELECT id FROM tk_users ORDER BY id')).rows;
      if (!options.ownerPasswordHashes || users.length !== Object.keys(options.ownerPasswordHashes).length
        || users.some(user => !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(options.ownerPasswordHashes![user.id] ?? ''))) throw new DomainError(409, 'recovery_password_reset_required');
      for (const user of users) await tx.query('UPDATE tk_users SET password_hash=$2 WHERE id=$1', [user.id, options.ownerPasswordHashes[user.id]]);
      const state = (await tx.query("UPDATE tk_recovery.state SET phase='complete',completed_at=now(),report=$1 WHERE singleton=true AND phase='restored' RETURNING singleton", [JSON.stringify(report)])).rows;
      if (state.length !== 1) throw new DomainError(409, 'recovery_state_conflict');
    }
    return report;
  });
}
