import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Database } from '../packages/core/src/index.ts';
import { connectDatabase } from '../packages/core/src/db.ts';

const migrations = ['001_init.sql', '002_auth.sql', '003_embeddings.sql', '004_capture_status.sql', '005_candidate_review.sql', '006_client_control.sql', '007_embedding_attempts.sql', '008_revision_kind.sql', '009_automatic_delivery.sql'];

/** Seed an explicit removal made by the retired review flow, including its history. */
export async function seedLegacyDismissal(db: Database, ownerId: string, memoryId: string) {
  await db.transaction(async tx => {
    const memory = (await tx.query('SELECT * FROM tk_memories WHERE owner_id=$1 AND id=$2', [ownerId, memoryId])).rows[0];
    if (!memory) throw new Error('Legacy dismissal fixture memory is missing.');
    await tx.query("UPDATE tk_revisions SET status='superseded' WHERE memory_id=$1 AND revision=$2", [memoryId, memory.revision]);
    await tx.query("UPDATE tk_memories SET status='dismissed',authoritative=false,revision=revision+1 WHERE id=$1", [memoryId]);
    await tx.query(`INSERT INTO tk_revisions(memory_id,revision,statement,origin,status,effective_at,editor_client_id,extractor,kind)
      VALUES ($1,$2,$3,$4,'dismissed',$5,'profile',$6,$7)`, [memoryId, Number(memory.revision) + 1, memory.statement, memory.origin, memory.effective_at, memory.extractor, memory.kind]);
    await tx.query(`INSERT INTO tk_evidence(memory_id,revision,source_id,quote)
      SELECT memory_id,$2,source_id,quote FROM tk_evidence WHERE memory_id=$1 AND revision=$3`, [memoryId, Number(memory.revision) + 1, memory.revision]);
    await tx.query('UPDATE tk_sources SET extraction_blocked=true WHERE id IN (SELECT source_id FROM tk_evidence WHERE memory_id=$1)', [memoryId]);
    await tx.query('DELETE FROM tk_embedding_attempts WHERE memory_id=$1', [memoryId]);
    await tx.query('UPDATE tk_owners SET snapshot_version=snapshot_version+1 WHERE id=$1', [ownerId]);
  });
}

// Explicit synthetic-only native opt-in. Every fixture owns a fresh schema;
// normal checks and no-vector fallback tests still run without native services.
async function createNativeTestDatabase(databaseUrl: string) {
  const schema = `tk_test_${randomUUID().replaceAll('-', '')}`;
  const admin = connectDatabase(databaseUrl);
  let db: ReturnType<typeof connectDatabase> | undefined;
  try {
    const extension = await admin.query("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'");
    if (extension.rows[0]?.nspname !== 'public') throw new Error('Native synthetic tests require pgvector preinstalled in the public schema.');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    db = connectDatabase(url.href);
    for (const migration of migrations) {
      await db.query(await readFile(new URL(`../deploy/migrations/${migration}`, import.meta.url), 'utf8'));
    }
    const database = db;
    return {
      db: database,
      backend: 'native' as const,
      async close() {
        await database.close();
        try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); }
      },
    };
  } catch (error) {
    await db?.close();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.close(); }
    throw error;
  }
}

/** Real PostgreSQL in WASM, without a mock SQL parser or a running daemon. */
export async function createTestDatabase(options: { vector?: boolean; snapshot?: Blob } = {}) {
  if (options.vector && process.env.THREADKEEPER_NATIVE_TEST_URL && !options.snapshot) return createNativeTestDatabase(process.env.THREADKEEPER_NATIVE_TEST_URL);
  const pglite = new PGlite({ ...(options.vector ? { extensions: { vector } } : {}), ...(options.snapshot ? { loadDataDir: options.snapshot } : {}) });
  await pglite.waitReady;
  for (const migration of migrations) {
    await pglite.exec(await readFile(new URL(`../deploy/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const transactionAdapter = (transaction: Transaction): Database => ({
    async exec(sql) { await transaction.exec(sql); },
    async query<T = any>(sql: string, parameters?: any[]) {
      const result = await transaction.query<T>(sql, parameters);
      return { rows: result.rows };
    },
    async transaction() {
      throw new Error('Nested transactions are unsupported in the test database');
    },
  });
  const db: Database = {
    async exec(sql) { await pglite.exec(sql); },
    async query<T = any>(sql: string, parameters?: any[]) {
      const result = await pglite.query<T>(sql, parameters);
      return { rows: result.rows };
    },
    async transaction(callback) {
      return pglite.transaction(transaction => callback(transactionAdapter(transaction)));
    },
  };
  return { db, pglite, backend: 'pglite' as const, close: () => pglite.close() };
}
