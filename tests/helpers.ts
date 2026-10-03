import { readFile } from 'node:fs/promises';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Database } from '../packages/core/src/index.ts';

/** Real PostgreSQL in WASM, without a mock SQL parser or a running daemon. */
export async function createTestDatabase() {
  const pglite = new PGlite();
  await pglite.waitReady;
  for (const migration of ['001_init.sql', '002_auth.sql']) {
    await pglite.exec(await readFile(new URL(`../deploy/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const transactionAdapter = (transaction: Transaction): Database => ({
    async query<T = any>(sql: string, parameters?: any[]) {
      const result = await transaction.query<T>(sql, parameters);
      return { rows: result.rows };
    },
    async transaction() {
      throw new Error('Nested transactions are unsupported in the test database');
    },
  });
  const db: Database = {
    async query<T = any>(sql: string, parameters?: any[]) {
      const result = await pglite.query<T>(sql, parameters);
      return { rows: result.rows };
    },
    async transaction(callback) {
      return pglite.transaction(transaction => callback(transactionAdapter(transaction)));
    },
  };
  return { db, pglite, close: () => pglite.close() };
}
