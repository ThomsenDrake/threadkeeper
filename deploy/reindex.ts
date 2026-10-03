import { createStore } from '../packages/core/src/index.ts';
import { connectDatabase } from '../packages/core/src/db.ts';
import { createEmbeddingProvider } from '../packages/providers/src/index.ts';
import { migrate } from './migrate.ts';
import { holdRuntimeGate } from '../packages/core/src/recovery-gate.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const gate = await holdRuntimeGate(databaseUrl, () => { console.error(JSON.stringify({ event: 'runtime_database_lock_lost' })); process.exit(1); });
const embeddings = createEmbeddingProvider();
if (!embeddings) throw new Error('EMBEDDING_MODEL and EMBEDDING_DIMENSIONS are required');
const database = connectDatabase(databaseUrl);
let indexed = 0;
let skipped = 0;
try {
  await migrate(database);
  const store = createStore(database, { embeddings });
  // The store replaces missing/mismatched current embeddings transactionally.
  // Changes to endpoint/model/dimensions/preprocessing select a new space; old
  // vectors never participate in recall while this rebuild makes progress.
  while (true) {
    const report = await store.processEmbeddings(32);
    indexed += report.indexed;
    skipped += report.skipped;
    if (report.status === 'idle' && report.pending === 0) {
      console.info(JSON.stringify({ event: 'reindex_complete', indexed, skipped }));
      break;
    }
    if (report.status !== 'complete') {
      // A cooldown or another worker's live claim is unfinished work, never a
      // successful rebuild. Retry later using the sanitized queue metadata.
      console.error(JSON.stringify({ event: 'reindex_failed', status: report.status, indexed, skipped,
        pending: report.pending, deferred: report.deferred, retry_after_ms: report.retry_after_ms }));
      process.exitCode = 1;
      break;
    }
    console.info(JSON.stringify({ event: 'reindex_progress', indexed, skipped }));
  }
} catch {
  // Native database/provider errors may contain credentials or source text.
  console.error(JSON.stringify({ event: 'reindex_failed', status: 'database_or_provider_failed', indexed, skipped }));
  process.exitCode = 1;
} finally {
  await database.close();
  await gate.close();
}
