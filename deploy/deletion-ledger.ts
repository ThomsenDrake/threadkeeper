import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectDatabase } from '../packages/core/src/db.ts';
import { exportDeletionLedger } from '../packages/core/src/recovery.ts';
import { holdRuntimeGate } from '../packages/core/src/recovery-gate.ts';

const { values } = parseArgs({ options: { owner: { type: 'string' }, output: { type: 'string' } } });
if (!values.owner || !values.output || !process.env.DATABASE_URL) throw new Error('--owner, --output and DATABASE_URL are required');
const gate = await holdRuntimeGate(process.env.DATABASE_URL, () => { process.exit(1); });
const db = connectDatabase(process.env.DATABASE_URL);
try {
  const ledger = await exportDeletionLedger(db, { ownerId: values.owner, clientId: 'operator', permissions: ['export'], projects: null });
  await writeFile(values.output, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.info(JSON.stringify({ event: 'deletion_ledger_exported', tombstones: ledger.tombstones.length, snapshot_version: ledger.snapshot_version }));
} catch {
  console.error(JSON.stringify({ event: 'deletion_ledger_export_failed' }));
  process.exitCode = 1;
} finally { await db.close(); await gate.close(); }
