import { createStore } from '../packages/core/src/index.ts';
import { connectDatabase } from '../packages/core/src/db.ts';
import { createEmbeddingProvider } from '../packages/providers/src/index.ts';
import { migrate } from './migrate.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
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
    if (report.status === 'idle') {
      console.info(JSON.stringify({ event: 'reindex_complete', indexed, skipped }));
      break;
    }
    if (report.status !== 'complete') {
      console.error(JSON.stringify({ event: 'reindex_failed', status: report.status, indexed, skipped }));
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
}
