import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { connectDatabase } from '../packages/core/src/db.ts';
import type { Database } from '../packages/core/src/index.ts';
import { holdRuntimeGate } from '../packages/core/src/recovery-gate.ts';

export type Migration = { name: string; sql: string };
export async function loadMigrations(): Promise<Migration[]> {
  const directory = new URL('./migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name => ({ name, sql: await readFile(new URL(name, directory), 'utf8') })));
}

// Existing rerunnable scripts are adopted once. Subsequent upgrades execute
// only new scripts; changing a recorded script is an explicit startup failure.
export async function migrate(db: Database, migrations?: Migration[]) {
  const scripts = migrations ?? await loadMigrations();
  if (scripts.some((script, index) => !/^\d{3}_[a-z_]+\.sql$/.test(script.name)
    || Number(script.name.slice(0, 3)) !== index + 1)) throw new Error('migration_sequence_invalid');
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(141422, 1)');
    await tx.query(`CREATE TABLE IF NOT EXISTS tk_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = (await tx.query('SELECT name,checksum FROM tk_schema_migrations ORDER BY name')).rows;
    const checksums = scripts.map(script => createHash('sha256').update(script.sql).digest('hex'));
    for (let index = 0; index < applied.length; index++) {
      const record = applied[index];
      if (!scripts.some(script => script.name === record.name)) throw new Error('migration_version_too_new');
      if (scripts[index]?.name !== record.name) throw new Error('migration_history_gap');
      if (checksums[index] !== record.checksum) throw new Error('migration_checksum_mismatch');
    }
    for (let index = applied.length; index < scripts.length; index++) {
      const script = scripts[index];
      if (tx.exec) await tx.exec(script.sql); else await tx.query(script.sql);
      await tx.query('INSERT INTO tk_schema_migrations(name,checksum) VALUES ($1,$2)', [script.name, checksums[index]]);
    }
    return { applied: scripts.length - applied.length, current: scripts.at(-1)?.name ?? null };
  });
}
if (process.argv[1]?.endsWith('/migrate.ts')) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const gate = await holdRuntimeGate(databaseUrl, () => { process.exit(1); });
  const db = connectDatabase(databaseUrl);
  try { console.info(JSON.stringify({ event: 'migrations_complete', ...await migrate(db) })); }
  finally { await db.close(); await gate.close(); }
}
