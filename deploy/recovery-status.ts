import { connectDatabase } from '../packages/core/src/db.ts';
const url = process.env.RESTORE_DATABASE_URL;
if (!url) throw new Error('RESTORE_DATABASE_URL is required');
const db = connectDatabase(url);
try {
  const state = (await db.query('SELECT phase,backup_hash,ledger_hash,started_at,completed_at,report FROM tk_recovery.state WHERE singleton=true')).rows[0];
  if (!state) throw new Error('recovery_state_missing');
  console.info(JSON.stringify({ event: 'recovery_status', ...state }));
} catch { console.error(JSON.stringify({ event: 'recovery_status_unavailable' })); process.exitCode = 1; }
finally { await db.close(); }
