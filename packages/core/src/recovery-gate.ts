import pg from 'pg';
import { DomainError, type Database } from './index.ts';

export const recoveryLock = [141422, 2] as const;

export async function assertRecoveryReady(db: Database) {
  const exists = (await db.query("SELECT to_regclass('tk_recovery.state') AS relation")).rows[0]?.relation;
  if (!exists) return; // Ordinary installations do not have recovery state.
  const state = (await db.query('SELECT phase FROM tk_recovery.state WHERE singleton=true')).rows[0];
  if (state?.phase !== 'complete') throw new DomainError(503, 'recovery_incomplete');
}

// Keep a dedicated connection: advisory session locks cannot be held through
// arbitrary pooled queries. Losing it must stop the service immediately.
export async function holdRuntimeGate(databaseUrl: string, onLost: () => void) {
  const client = new pg.Client({ connectionString: databaseUrl });
  client.on('error', onLost);
  client.on('end', onLost);
  try {
    await client.connect();
    const result = await client.query('SELECT pg_try_advisory_lock_shared($1,$2) AS acquired', [...recoveryLock]);
    if (!result.rows[0]?.acquired) throw new DomainError(503, 'recovery_in_progress');
    await assertRecoveryReady({ query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }), transaction: async () => { throw new Error('unsupported'); } });
    return { close: async () => { client.removeListener('error', onLost); client.removeListener('end', onLost); await client.end(); } };
  } catch (error) {
    client.removeListener('error', onLost);
    client.removeListener('end', onLost);
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function prepareRecoveryState(db: Database, backupHash: string, ledgerHash: string) {
  await db.transaction(async tx => {
    await tx.query('CREATE SCHEMA tk_recovery');
    await tx.query(`CREATE TABLE tk_recovery.state (
      singleton boolean PRIMARY KEY CHECK (singleton),
      phase text NOT NULL CHECK (phase IN ('prepared','restored','complete')),
      backup_hash text NOT NULL, ledger_hash text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      report jsonb
    )`);
    await tx.query("INSERT INTO tk_recovery.state(singleton,phase,backup_hash,ledger_hash) VALUES (true,'prepared',$1,$2)", [backupHash, ledgerHash]);
  });
}
