import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, loadMigrations } from '../deploy/migrate.ts';
import { createTestDatabase } from './helpers.ts';

test('migration ledger adopts legacy setup once and refuses edited or future histories', async () => {
  const { db, close } = await createTestDatabase();
  try {
    const scripts = await loadMigrations();
    assert.deepEqual(await migrate(db), { applied: scripts.length, current: scripts.at(-1)!.name });
    assert.equal((await db.query('SELECT count(*) AS count FROM tk_schema_migrations')).rows[0].count, scripts.length);
    assert.deepEqual(await migrate(db), { applied: 0, current: scripts.at(-1)!.name });
    await assert.rejects(migrate(db, scripts.map((script, index) => index ? script : { ...script, sql: script.sql + '\n-- changed' })), /migration_checksum_mismatch/);
    await db.query("INSERT INTO tk_schema_migrations(name,checksum) VALUES ('999_future.sql','unrecognized')");
    await assert.rejects(migrate(db), /migration_version_too_new/);
  } finally { await close(); }
});

test('a failed pending upgrade rolls back its SQL and migration records', async () => {
  const { db, close } = await createTestDatabase();
  try {
    const scripts = [{ name: '001_fixture.sql', sql: 'CREATE TABLE migration_fixture(value integer); INSERT INTO migration_fixture VALUES (1);' },
      { name: '002_failure.sql', sql: 'CREATE TABLE migration_partial(value integer); SELECT missing_column FROM migration_fixture;' }];
    await assert.rejects(migrate(db, scripts));
    assert.equal((await db.query("SELECT to_regclass('migration_fixture') AS relation")).rows[0].relation, null);
    assert.equal((await db.query("SELECT to_regclass('migration_partial') AS relation")).rows[0].relation, null);
    assert.equal((await db.query("SELECT to_regclass('tk_schema_migrations') AS relation")).rows[0].relation, null);
    await migrate(db, scripts.slice(0, 1));
    await db.query('INSERT INTO migration_fixture VALUES (2)');
    await migrate(db, scripts.slice(0, 1));
    assert.deepEqual((await db.query('SELECT value FROM migration_fixture ORDER BY value')).rows.map(row => row.value), [1, 2]);
  } finally { await close(); }
});

test('migration ledger rejects a history with a missing intermediate entry', async () => {
  const { db, close } = await createTestDatabase();
  try {
    await migrate(db);
    await db.query("DELETE FROM tk_schema_migrations WHERE name LIKE '002_%'");
    await assert.rejects(migrate(db), /migration_history_gap/);
  } finally { await close(); }
});
