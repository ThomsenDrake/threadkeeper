import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { finished } from 'node:stream/promises';
import pg from 'pg';
import type { Database } from '../packages/core/src/index.ts';
import { DomainError } from '../packages/core/src/index.ts';
import { canonical } from '../packages/core/src/hashing.ts';
import { parseDeletionLedger, reconcileDeletions } from '../packages/core/src/recovery.ts';
import { prepareRecoveryState, recoveryLock } from '../packages/core/src/recovery-gate.ts';
import { migrate } from './migrate.ts';
import { passwordHash } from '../apps/api/src/auth.ts';

export type RestoreOptions = { backup: string; ledgers: string[]; targetName: string; restoreUrl: string; runtimeUrl: string; passwordsFile: string; pgRestore?: string };

export function validateRestoreTarget(options: Pick<RestoreOptions, 'targetName' | 'restoreUrl' | 'runtimeUrl'>) {
  if (!options.restoreUrl || !options.runtimeUrl) throw new DomainError(400, 'restore_and_runtime_urls_required');
  const target = new URL(options.restoreUrl), runtime = new URL(options.runtimeUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || !target.username
    || !/^tk_restore_[a-z0-9_]+$/.test(options.targetName) || options.targetName.length > 63
    || decodeURIComponent(target.pathname.slice(1)) !== options.targetName
    || decodeURIComponent(runtime.pathname.slice(1)) === options.targetName
    || [...target.searchParams.keys()].some(key => key !== 'sslmode')) throw new DomainError(400, 'invalid_restore_target');
  return target;
}

async function digestFile(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function databaseFor(client: pg.Client): Database {
  const tx: Database = { query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }),
    exec: async sql => { await client.query(sql); }, transaction: async () => { throw new Error('Nested transactions unsupported'); } };
  return { ...tx, transaction: async callback => {
    await client.query('BEGIN');
    try { const result = await callback(tx); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  } };
}

export async function restoreTargetHasObjects(db: Pick<Database, 'query'>, allowRecoverySchema = false) {
  const excluded = ['information_schema', ...(allowRecoverySchema ? ['tk_recovery'] : [])];
  const result = await db.query(`SELECT EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_namespace n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid
      WHERE n.nspname !~ '^pg_' AND NOT (n.nspname=ANY($1::text[]))
    UNION ALL SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'public' AND NOT (n.nspname=ANY($1::text[]))
    UNION ALL SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'
    UNION ALL SELECT 1 FROM pg_largeobject_metadata
  ) AS present`, [excluded]);
  return Boolean(result.rows[0]?.present);
}

async function restoreArchive(options: RestoreOptions, url: URL, expectedHash: string) {
  // Passwords stay in child environment, never argv or operational output.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const environment = { ...inherited, PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: options.targetName, PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer', PGPASSFILE: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const child = spawn(options.pgRestore ?? 'pg_restore', ['--dbname', options.targetName, '--exclude-schema=tk_recovery',
    '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl'], { env: environment, stdio: ['pipe', 'ignore', 'ignore'] });
  const archive = createReadStream(options.backup);
  const streamed = createHash('sha256');
  archive.on('data', chunk => { streamed.update(chunk); });
  archive.on('error', () => { child.kill(); });
  child.stdin.on('error', () => { archive.destroy(); });
  archive.pipe(child.stdin);
  try {
    await Promise.all([finished(archive), new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new DomainError(500, 'pg_restore_unavailable')));
      child.once('close', code => code === 0 ? resolve() : reject(new DomainError(500, 'archive_restore_failed')));
    })]);
    if (streamed.digest('hex') !== expectedHash) throw new DomainError(409, 'recovery_backup_changed');
  } finally { archive.destroy(); }
}

export async function restoreDatabase(options: RestoreOptions) {
  const target = validateRestoreTarget(options);
  const ledgers = await Promise.all(options.ledgers.map(async path => {
    const file = await readFile(path);
    if (file.length > 32 * 1024 * 1024) throw new DomainError(400, 'deletion_ledger_too_large');
    return parseDeletionLedger(JSON.parse(file.toString('utf8')));
  }));
  if (new Set(ledgers.map(ledger => ledger.owner_id)).size !== ledgers.length) throw new DomainError(400, 'duplicate_ledger_owner');
  const ledgerHash = createHash('sha256').update(canonical([...ledgers].sort((a, b) => a.owner_id.localeCompare(b.owner_id)))).digest('hex');
  const backupHash = await digestFile(options.backup);
  if (process.platform !== 'win32' && ((await stat(options.passwordsFile)).mode & 0o077) !== 0) throw new DomainError(400, 'recovery_password_file_not_private');
  const passwords = JSON.parse(await readFile(options.passwordsFile, 'utf8')) as unknown;
  if (!passwords || typeof passwords !== 'object' || Array.isArray(passwords)
    || Object.entries(passwords).some(([id, password]) => !id || typeof password !== 'string' || password.length < 12 || password.length > 1024)) throw new DomainError(400, 'recovery_password_file_invalid');
  const ownerPasswordHashes = Object.fromEntries(Object.entries(passwords).map(([id, password]) => [id, passwordHash(password as string)]));
  const client = new pg.Client({ connectionString: options.restoreUrl });
  await client.connect();
  try {
    const db = databaseFor(client);
    const actual = (await client.query('SELECT current_database() AS name,current_schema() AS schema')).rows[0];
    if (actual.name !== options.targetName || actual.schema !== 'public') throw new DomainError(400, 'invalid_restore_target');
    if (!(await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [...recoveryLock])).rows[0]?.acquired) throw new DomainError(409, 'restore_target_in_use');
    const otherConnections = await client.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()');
    if (otherConnections.rows.length) throw new DomainError(409, 'restore_target_in_use');
    const exists = (await client.query("SELECT to_regclass('tk_recovery.state') AS relation")).rows[0]?.relation;
    if (!exists) {
      if (await restoreTargetHasObjects(db)) throw new DomainError(409, 'restore_target_not_empty');
      await prepareRecoveryState(db, backupHash, ledgerHash);
    }
    const state = (await client.query('SELECT phase,backup_hash,ledger_hash,report FROM tk_recovery.state WHERE singleton=true')).rows[0];
    if (!state || state.backup_hash !== backupHash || state.ledger_hash !== ledgerHash) throw new DomainError(409, 'recovery_artifact_mismatch');
    if (state.phase === 'complete') return { status: 'already_complete', ...state.report };
    if (state.phase === 'prepared') {
      if (await restoreTargetHasObjects(db, true)) throw new DomainError(409, 'recovery_restore_ambiguous');
      await restoreArchive(options, target, backupHash);
      await client.query("UPDATE tk_recovery.state SET phase='restored' WHERE singleton=true AND phase='prepared'");
    }
    await migrate(db);
    return { status: 'complete', ...await reconcileDeletions(db, ledgers, { completeGate: true, ownerPasswordHashes }) };
  } finally { await client.end(); }
}

if (process.argv[1]?.endsWith('/restore.ts')) {
  try {
    const { values } = parseArgs({ options: { backup: { type: 'string' }, ledger: { type: 'string', multiple: true }, 'target-db': { type: 'string' } } });
    if (!values.backup || !values['target-db'] || !values.ledger?.length) throw new DomainError(400, 'restore_arguments_required');
    const report = await restoreDatabase({ backup: values.backup, ledgers: values.ledger, targetName: values['target-db'],
      restoreUrl: process.env.RESTORE_DATABASE_URL ?? '', runtimeUrl: process.env.DATABASE_URL ?? '', passwordsFile: process.env.RESTORE_PASSWORDS_FILE ?? '', pgRestore: process.env.THREADKEEPER_PG_RESTORE });
    console.info(JSON.stringify({ event: 'recovery_complete', ...report }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'recovery_failed', error_code: error instanceof DomainError ? error.code : 'recovery_database_or_artifact_failed' }));
    process.exitCode = 1;
  }
}
