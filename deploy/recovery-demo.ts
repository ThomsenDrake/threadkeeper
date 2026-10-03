import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createAuth } from '../apps/api/src/auth.ts';
import { connectDatabase } from '../packages/core/src/db.ts';
import { connectedDeletionRecords } from '../packages/core/src/deletion.ts';
import { createStore, DomainError } from '../packages/core/src/index.ts';
import { holdRuntimeGate, recoveryLock } from '../packages/core/src/recovery-gate.ts';
import { seedRecoveryFixture } from '../tests/recovery-fixtures.ts';
import { loadMigrations, migrate } from './migrate.ts';
import { restoreDatabase, type RestoreOptions } from './restore.ts';

// This opt-in harness owns its database server. It ignores saved Docker contexts
// and operator database/provider configuration; archives and credentials stay
// in its private temporary directory and disappear with the disposable server.
const dockerEnvironment = { ...process.env };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnvironment[name];
for (const name of Object.keys(dockerEnvironment)) {
  if (/^(PG|DATABASE_URL$|RESTORE_|THREADKEEPER_PG_RESTORE$|MODEL_|EMBEDDING_|NEBIUS_|POSTGRES_|BOOTSTRAP_)/.test(name)) delete dockerEnvironment[name];
}
// node-postgres also consults PG* defaults. This disposable process must not
// inherit an operator search path, TLS setting or PostgreSQL service selector.
for (const name of Object.keys(process.env)) if (name.startsWith('PG')) delete process.env[name];
const secrets: string[] = [];
const redact = (value: string) => secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), value);
const failure = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const cancellation = new AbortController();
let currentChild: ReturnType<typeof spawn> | undefined;
let interrupted = false;
let cleaning = false;
function interrupt() {
  interrupted = true;
  cancellation.abort();
  if (!cleaning) currentChild?.kill('SIGTERM');
}

async function docker(args: string[], options: { cleanup?: boolean } = {}) {
  if (interrupted && !options.cleanup) throw new Error('Recovery demonstration interrupted');
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], { env: dockerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    currentChild = child;
    const output: Buffer[] = [], errors: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.stdout.on('data', data => output.push(Buffer.from(data)));
    child.stderr.on('data', data => errors.push(Buffer.from(data)));
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (currentChild === child) currentChild = undefined;
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(redact(`docker ${args[0]} failed (${code ?? 'signal'}): ${Buffer.concat(errors).toString('utf8').slice(-2000)}`)));
    });
  });
}

async function isolatedQuery(databaseUrl: string, sql: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try { return (await client.query(sql)).rows; }
  finally { await client.end(); }
}

async function main() {
  assert.equal(process.versions.node.split('.')[0], '24', 'Recovery demonstration requires Node.js 24');
  const suffix = randomBytes(6).toString('hex');
  const container = `threadkeeper-recovery-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-recovery-'));
  const dbPassword = randomBytes(32).toString('hex');
  const newOwnerPassword = randomBytes(32).toString('hex');
  secrets.push(dbPassword, newOwnerPassword);
  const envFile = join(directory, 'postgres.env');
  const sourceName = `tk_source_${suffix}`;
  const targetName = `tk_restore_${suffix}`;
  const failureName = `tk_restore_fail_${suffix}`;
  const rollbackName = `tk_restore_rollback_${suffix}`;
  const migrationName = `tk_migration_${suffix}`;
  const backup = join(directory, 'older.dump');
  const passwordsFile = join(directory, 'passwords.json');
  const pgRestore = join(directory, 'pg-restore.mjs');
  const checks: string[] = [];
  let serverCreated = false;
  let admin: pg.Client | undefined;
  let source: ReturnType<typeof connectDatabase> | undefined;
  let target: ReturnType<typeof connectDatabase> | undefined;
  let failedTarget: ReturnType<typeof connectDatabase> | undefined;
  let rollbackTarget: ReturnType<typeof connectDatabase> | undefined;
  let migrationA: ReturnType<typeof connectDatabase> | undefined;
  let migrationB: ReturnType<typeof connectDatabase> | undefined;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    console.info('Threadkeeper recovery: SYNTHETIC native PostgreSQL/pgvector archive; no provider calls or live data.');
    await writeFile(envFile, `POSTGRES_USER=threadkeeper\nPOSTGRES_PASSWORD=${dbPassword}\nPOSTGRES_DB=postgres\n`, { mode: 0o600 });
    const engine = (await docker(['info', '--format', '{{.ServerVersion}}'])).toString().trim();
    serverCreated = true; // Cleanup also covers an interrupted docker run.
    await docker(['run', '--detach', '--rm', '--name', container, '--env-file', envFile,
      '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', 'pgvector/pgvector:pg17']);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await docker(['exec', container, 'pg_isready', '--username=threadkeeper', '--dbname=postgres']); ready = true; break; }
      catch { await delay(200, undefined, { signal: cancellation.signal }); }
    }
    assert.ok(ready, 'Disposable native PostgreSQL did not become ready within 20 seconds');
    const address = (await docker(['port', container, '5432/tcp'])).toString().trim();
    assert.match(address, /^127\.0\.0\.1:\d+$/, 'Database must be published only on localhost');
    const urlFor = (database: string) => `postgresql://threadkeeper:${dbPassword}@${address}/${database}?sslmode=disable`;
    admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    for (const name of [sourceName, targetName, failureName, rollbackName, migrationName]) await admin.query(`CREATE DATABASE ${name}`);
    source = connectDatabase(urlFor(sourceName));
    // Prove legacy adoption on native PostgreSQL, then back up the recorded
    // migration history so restore also verifies current historical checksums.
    const scripts = await loadMigrations();
    for (const script of scripts) await source.exec!(script.sql);
    assert.equal((await migrate(source)).applied, scripts.length);
    assert.equal((await migrate(source)).applied, 0);
    checks.push('native legacy migration adoption and unchanged rerun');
    const fixture = await seedRecoveryFixture(source);
    const affected = await connectedDeletionRecords(source, fixture.profile.ownerId,
      { memory_ids: [...fixture.corrected.memory_ids, fixture.confirmed, fixture.dismissed], source_ids: [] });
    assert.ok(Number((await source.query('SELECT count(*) AS count FROM tk_embeddings')).rows[0].count) > 0, 'Archive must contain real pgvector rows');
    const versions = (await source.query("SELECT current_setting('server_version') AS postgres,(SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector")).rows[0];
    const archive = await docker(['exec', container, 'pg_dump', '--username=threadkeeper', `--dbname=${sourceName}`, '--format=custom']);
    assert.equal(archive.subarray(0, 5).toString('ascii'), 'PGDMP', 'Archive must be a native custom-format pg_dump');
    await writeFile(backup, archive, { mode: 0o600 });
    const ledgers = await fixture.newerLedgers();
    const ledgerPaths = await Promise.all(ledgers.map(async (ledger, index) => {
      const path = join(directory, `ledger-${index}.json`);
      await writeFile(path, JSON.stringify(ledger), { mode: 0o600 });
      return path;
    }));
    await writeFile(passwordsFile, JSON.stringify({ [fixture.profile.ownerId]: newOwnerPassword }), { mode: 0o600 });
    // The host needs no pg_restore installation. This private executable forwards
    // the archive stdin to the matching native executable in our own container.
    // PostgreSQL credentials remain in environment variables, never argv.
    await writeFile(pgRestore, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nconst env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432' };\nfor (const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete env[key];\nconst child = spawn('docker', ['--host=unix:///var/run/docker.sock','exec','--interactive','--env','PGHOST','--env','PGPORT','--env','PGUSER','--env','PGPASSWORD','--env','PGDATABASE','--env','PGSSLMODE',${JSON.stringify(container)},'pg_restore',...process.argv.slice(2)], { env, stdio: ['pipe','ignore','ignore'] });\nconst timeout = setTimeout(() => child.kill('SIGTERM'), 30000);\nprocess.stdin.pipe(child.stdin);\nchild.stdin.on('error', () => process.stdin.destroy());\nchild.on('error', () => { clearTimeout(timeout); process.exitCode = 1; process.stdin.destroy(); });\nchild.on('close', code => { clearTimeout(timeout); process.exitCode = code ?? 1; process.stdin.destroy(); });\n`, { mode: 0o700 });
    const options: RestoreOptions = { backup, ledgers: ledgerPaths, targetName, restoreUrl: urlFor(targetName), runtimeUrl: urlFor(sourceName), passwordsFile, pgRestore };

    // Functions and standalone enums do not have pg_class rows. They must still
    // reject a supposedly fresh target before any marker or archive is written.
    await isolatedQuery(options.restoreUrl, "CREATE FUNCTION public.synthetic_existing() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
    await assert.rejects(restoreDatabase(options), failure('restore_target_not_empty'));
    assert.equal((await isolatedQuery(options.restoreUrl, "SELECT to_regclass('tk_recovery.state') AS relation"))[0].relation, null);
    await isolatedQuery(options.restoreUrl, 'DROP FUNCTION public.synthetic_existing()');
    await isolatedQuery(options.restoreUrl, "CREATE TYPE public.synthetic_existing AS ENUM ('fixture')");
    await assert.rejects(restoreDatabase(options), failure('restore_target_not_empty'));
    assert.equal((await isolatedQuery(options.restoreUrl, "SELECT to_regclass('tk_recovery.state') AS relation"))[0].relation, null);
    await isolatedQuery(options.restoreUrl, 'DROP TYPE public.synthetic_existing');
    await isolatedQuery(options.restoreUrl, 'SELECT lo_create(424242)');
    await assert.rejects(restoreDatabase(options), failure('restore_target_not_empty'));
    assert.equal((await isolatedQuery(options.restoreUrl, "SELECT to_regclass('tk_recovery.state') AS relation"))[0].relation, null);
    await isolatedQuery(options.restoreUrl, 'SELECT lo_unlink(424242)');
    await isolatedQuery(options.restoreUrl, 'CREATE SCHEMA pgx_private');
    await isolatedQuery(options.restoreUrl, 'CREATE TABLE pgx_private.synthetic_existing(value text)');
    await assert.rejects(restoreDatabase(options), failure('restore_target_not_empty'));
    assert.equal((await isolatedQuery(options.restoreUrl, "SELECT to_regclass('tk_recovery.state') AS relation"))[0].relation, null);
    await isolatedQuery(options.restoreUrl, 'DROP SCHEMA pgx_private CASCADE');
    checks.push('native fresh targets containing functions, enums, large objects or tables in legitimate pgx_private schemas are rejected before marker/archive writes');

    const runtime = await holdRuntimeGate(options.restoreUrl, () => { throw new Error('Synthetic gate connection lost'); });
    try { await assert.rejects(restoreDatabase(options), failure('restore_target_in_use')); }
    finally { await runtime.close(); }
    const exclusive = new pg.Client({ connectionString: options.restoreUrl });
    await exclusive.connect();
    try {
      assert.equal((await exclusive.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [...recoveryLock])).rows[0].acquired, true);
      await assert.rejects(holdRuntimeGate(options.restoreUrl, () => undefined), failure('recovery_in_progress'));
    } finally { await exclusive.end(); }
    checks.push('native shared runtime lock blocks recovery; exclusive recovery lock blocks startup');

    const report = await restoreDatabase(options);
    assert.equal(report.status, 'complete');
    assert.equal(report.deleted_memories, affected.memories.length);
    assert.equal(report.deleted_sources, affected.sources.length);
    assert.equal(report.deleted_jobs, affected.jobs.length);
    assert.equal(report.revoked_clients, 1);
    assert.equal(report.deleted_sessions, 1);
    target = connectDatabase(options.restoreUrl);
    const store = createStore(target), auth = createAuth(target);
    assert.deepEqual((await store.list(fixture.profile)).memories.map(memory => memory.id), fixture.survivor.memory_ids);
    assert.equal((await store.list(fixture.other)).memories.length, fixture.unrelated.memory_ids.length);
    for (const source of affected.sources) await assert.rejects(store.getSource(fixture.profile, source.id), failure('source_not_found'));
    const deleted = [...fixture.corrected.memory_ids, fixture.confirmed, fixture.dismissed];
    for (const table of ['tk_memories', 'tk_revisions', 'tk_evidence', 'tk_embeddings']) {
      assert.equal((await target.query(`SELECT 1 FROM ${table} WHERE ${table === 'tk_memories' ? 'id' : 'memory_id'}=ANY($1::text[])`, [deleted])).rows.length, 0);
    }
    assert.equal((await target.query('SELECT 1 FROM tk_jobs WHERE id=$1', [fixture.duplicate.job_id])).rows.length, 0);
    assert.equal((await store.captureStatus(fixture.profile, fixture.duplicate.capture_id)).status, 'cancelled');
    assert.equal((await store.search(fixture.profile, { query: 'deadline' })).memories.length, 0);
    assert.deepEqual((await store.search(fixture.profile, { query: 'surviving' })).memories.map(memory => memory.id), fixture.survivor.memory_ids);
    const exported = await store.export(fixture.profile);
    assert.equal(exported.memories.length, 1);
    assert.equal(JSON.stringify(exported.sources).includes('Friday'), false);
    assert.equal(JSON.stringify(exported.revisions).includes('confirms detailed'), false);
    assert.equal(await store.processJob({ extract: async () => { throw new Error('Forgotten jobs must never call a provider'); } }), null);
    checks.push('actual pg_dump/pg_restore purges forgotten histories, duplicate sources, jobs, vectors, profile/recall/export; unrelated owner survives');
    assert.equal(await auth.principal({ authorization: `Bearer ${fixture.grant.token}` }), null);
    assert.equal(await auth.principal({ cookie: `tk_session=${fixture.session!.token}` }), null);
    assert.equal(await auth.login('recovery@example.invalid', 'synthetic-old-password'), null);
    const freshSession = await auth.login('recovery@example.invalid', newOwnerPassword);
    assert.ok(freshSession);
    assert.ok(await auth.principal({ cookie: `tk_session=${freshSession.token}` }));
    assert.equal((await target.query('SELECT id,revoked_at FROM tk_clients')).rows[0].id, fixture.grant.client.id);
    const marker = (await target.query('SELECT phase,completed_at FROM tk_recovery.state')).rows[0];
    assert.equal(marker.phase, 'complete');
    assert.ok(marker.completed_at);
    const restoredRuntime = await holdRuntimeGate(options.restoreUrl, () => undefined);
    await restoredRuntime.close();
    const snapshot = (await target.query('SELECT id,snapshot_version FROM tk_owners ORDER BY id')).rows;
    // Restore deliberately rejects any other target connections, including our
    // verification pool; close it before proving repeat execution is a no-op.
    await target.close(); target = undefined;
    assert.equal((await restoreDatabase(options)).status, 'already_complete');
    target = connectDatabase(options.restoreUrl);
    assert.deepEqual((await target.query('SELECT id,snapshot_version FROM tk_owners ORDER BY id')).rows, snapshot);
    assert.ok(await createAuth(target).principal({ cookie: `tk_session=${freshSession.token}` }));
    checks.push('password rotated, restored clients/sessions revoked, complete startup allowed, same-artifact repetition is a no-op');

    const invalidBackup = join(directory, 'invalid.dump');
    await writeFile(invalidBackup, 'synthetic invalid archive', { mode: 0o600 });
    const failedOptions = { ...options, backup: invalidBackup, targetName: failureName, restoreUrl: urlFor(failureName) };
    await assert.rejects(restoreDatabase(failedOptions), failure('archive_restore_failed'));
    failedTarget = connectDatabase(urlFor(failureName));
    assert.equal((await failedTarget.query('SELECT phase FROM tk_recovery.state')).rows[0].phase, 'prepared');
    assert.equal((await failedTarget.query("SELECT to_regclass('tk_memories') AS relation")).rows[0].relation, null);
    await assert.rejects(holdRuntimeGate(urlFor(failureName), () => undefined), failure('recovery_incomplete'));
    checks.push('native pg_restore failure retains a pending marker and blocks startup');
    await failedTarget.close(); failedTarget = undefined;
    await isolatedQuery(failedOptions.restoreUrl, "CREATE FUNCTION public.synthetic_ambiguous() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
    await assert.rejects(restoreDatabase(failedOptions), failure('recovery_restore_ambiguous'));
    assert.equal((await isolatedQuery(failedOptions.restoreUrl, 'SELECT phase FROM tk_recovery.state'))[0].phase, 'prepared');
    await isolatedQuery(failedOptions.restoreUrl, 'DROP FUNCTION public.synthetic_ambiguous()');
    await isolatedQuery(failedOptions.restoreUrl, "CREATE TYPE public.synthetic_ambiguous AS ENUM ('fixture')");
    await assert.rejects(restoreDatabase(failedOptions), failure('recovery_restore_ambiguous'));
    assert.equal((await isolatedQuery(failedOptions.restoreUrl, 'SELECT phase FROM tk_recovery.state'))[0].phase, 'prepared');
    await assert.rejects(holdRuntimeGate(failedOptions.restoreUrl, () => undefined), failure('recovery_incomplete'));
    await isolatedQuery(failedOptions.restoreUrl, 'DROP TYPE public.synthetic_ambiguous');
    await isolatedQuery(failedOptions.restoreUrl, 'SELECT lo_create(424242)');
    await assert.rejects(restoreDatabase(failedOptions), failure('recovery_restore_ambiguous'));
    assert.equal((await isolatedQuery(failedOptions.restoreUrl, 'SELECT phase FROM tk_recovery.state'))[0].phase, 'prepared');
    await assert.rejects(holdRuntimeGate(failedOptions.restoreUrl, () => undefined), failure('recovery_incomplete'));
    await isolatedQuery(failedOptions.restoreUrl, 'SELECT lo_unlink(424242)');
    await isolatedQuery(failedOptions.restoreUrl, 'CREATE SCHEMA pgx_private');
    await isolatedQuery(failedOptions.restoreUrl, 'CREATE TABLE pgx_private.synthetic_ambiguous(value text)');
    await assert.rejects(restoreDatabase(failedOptions), failure('recovery_restore_ambiguous'));
    assert.equal((await isolatedQuery(failedOptions.restoreUrl, 'SELECT phase FROM tk_recovery.state'))[0].phase, 'prepared');
    await assert.rejects(holdRuntimeGate(failedOptions.restoreUrl, () => undefined), failure('recovery_incomplete'));
    checks.push('native prepared targets with functions, enums, large objects or pgx_private tables refuse ambiguous replay and remain gated');

    const missingPasswords = join(directory, 'missing-passwords.json');
    await writeFile(missingPasswords, '{}', { mode: 0o600 });
    const rollbackOptions = { ...options, targetName: rollbackName, restoreUrl: urlFor(rollbackName), passwordsFile: missingPasswords };
    await assert.rejects(restoreDatabase(rollbackOptions), failure('recovery_password_reset_required'));
    rollbackTarget = connectDatabase(urlFor(rollbackName));
    assert.equal((await rollbackTarget.query('SELECT phase FROM tk_recovery.state')).rows[0].phase, 'restored');
    assert.equal((await rollbackTarget.query('SELECT 1 FROM tk_memories WHERE id=ANY($1::text[])', [deleted])).rows.length, deleted.length);
    assert.equal((await rollbackTarget.query('SELECT 1 FROM tk_clients WHERE revoked_at IS NULL')).rows.length, 1);
    assert.equal((await rollbackTarget.query('SELECT 1 FROM tk_sessions')).rows.length, 1);
    await assert.rejects(holdRuntimeGate(urlFor(rollbackName), () => undefined), failure('recovery_incomplete'));
    await rollbackTarget.close(); rollbackTarget = undefined;
    assert.equal((await restoreDatabase({ ...rollbackOptions, passwordsFile })).status, 'complete');
    checks.push('native failed reconciliation rolls back purge and credentials, remains gated, and resumes with the same archive/ledgers');

    migrationA = connectDatabase(urlFor(migrationName));
    migrationB = connectDatabase(urlFor(migrationName));
    const once = [{ name: '001_native.sql', sql: 'CREATE TABLE native_migration_proof(value integer); INSERT INTO native_migration_proof VALUES (1);' }];
    const concurrent = await Promise.all([migrate(migrationA, once), migrate(migrationB, once)]);
    assert.equal(concurrent.reduce((sum, result) => sum + result.applied, 0), 1);
    assert.equal((await migrationA.query('SELECT count(*) AS count FROM native_migration_proof')).rows[0].count, '1');
    await assert.rejects(migrate(migrationA, [{ ...once[0], sql: `${once[0].sql}\n-- changed` }]), /migration_checksum_mismatch/);
    await assert.rejects(migrate(migrationA, [...once, { name: '002_failure.sql', sql: 'CREATE TABLE native_partial(value integer); SELECT missing_column FROM native_migration_proof;' }]));
    assert.equal((await migrationA.query("SELECT to_regclass('native_partial') AS relation")).rows[0].relation, null);
    assert.equal((await migrationA.query('SELECT count(*) AS count FROM tk_schema_migrations')).rows[0].count, '1');
    checks.push('native concurrent migrations apply once, changed checksums fail, failed upgrades roll back SQL and ledger');
    const image = (await docker(['image', 'inspect', 'pgvector/pgvector:pg17', '--format', '{{join .RepoDigests ","}}'])).toString().trim();
    console.info(JSON.stringify({ result: 'PASS', evidence: 'native-postgresql-custom-archive-synthetic-recovery', node: process.versions.node, docker: engine, versions, image, archive_bytes: archive.length, report, checks }, null, 2));
  } finally {
    cleaning = true;
    const closed = await Promise.allSettled([source?.close(), target?.close(), failedTarget?.close(), rollbackTarget?.close(), migrationA?.close(), migrationB?.close(), admin?.end()]);
    let cleanupError: unknown;
    try {
      if (serverCreated) {
        const existing = (await docker(['ps', '--all', '--quiet', '--filter', `name=^/${container}$`], { cleanup: true })).toString().trim();
        if (existing) await docker(['rm', '--force', container], { cleanup: true });
        assert.equal((await docker(['ps', '--all', '--quiet', '--filter', `name=^/${container}$`], { cleanup: true })).toString().trim(), '');
      }
    } catch (error) { cleanupError = error; }
    try {
      await rm(directory, { recursive: true, force: true });
      if (!cleanupError) console.info('Cleanup: disposable native server, archives and synthetic credentials removed.');
    } catch (error) { cleanupError ??= error; }
    finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
    if (cleanupError) throw cleanupError;
    const failedClose = closed.find(result => result.status === 'rejected');
    if (failedClose?.status === 'rejected') throw failedClose.reason;
  }
}

await main().catch(error => {
  console.error(`Recovery demonstration failed: ${redact(error instanceof Error ? error.message : 'unknown failure')}`);
  process.exitCode = 1;
});
