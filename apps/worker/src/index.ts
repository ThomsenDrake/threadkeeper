import { createStore } from '../../../packages/core/src/index.ts';
import { connectDatabase } from '../../../packages/core/src/db.ts';
import { createEmbeddingProvider, createProvider } from '@threadkeeper/providers';
import { holdRuntimeGate } from '../../../packages/core/src/recovery-gate.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const gate = await holdRuntimeGate(databaseUrl, () => { console.error(JSON.stringify({ event: 'runtime_database_lock_lost' })); process.exit(1); });
const pollMs = Number(process.env.WORKER_POLL_MS || '1000');
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('WORKER_POLL_MS must be between 100 and 60000');

const provider = createProvider();
const embeddings = createEmbeddingProvider();
const database = connectDatabase(databaseUrl);
const store = createStore(database, { embeddings });
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; wake?.(); });
}

// One extraction job and one bounded embedding batch per cycle so either queue
// can make progress. Database reconciliation rechecks edits/deletions on commit.
try {
  console.info(JSON.stringify({ event: 'worker_started', model: provider.config.modelId, embeddings_enabled: Boolean(embeddings) }));
  while (!stopping) {
    try {
      const report = await store.processJob(provider);
      if (report) {
        // Counts and opaque IDs only. Source text, model output, keys, and URLs
        // must not enter operational logs.
        console.info(JSON.stringify({
          event: 'job_processed', job_id: report.job_id, status: report.status,
          accepted: report.accepted,
          ...('skipped' in report ? { skipped: report.skipped } : {}),
          ...('model' in report ? { model: report.model } : {}),
          ...('usage' in report ? { usage: report.usage } : {}),
          ...('error_code' in report ? { error_code: report.error_code } : {}),
        }));
      }
    } catch {
      console.error(JSON.stringify({ event: 'worker_iteration_failed' }));
    }
    if (stopping) break;
    try {
      const report = await store.processEmbeddings(32);
      if (!['disabled', 'idle', 'deferred'].includes(report.status)) {
        console.info(JSON.stringify({ event: 'embeddings_processed', ...report }));
      }
    } catch {
      console.error(JSON.stringify({ event: 'embedding_iteration_failed' }));
    }
    if (stopping) break;
    // Always poll, including after failures or skipped stale work. A broken
    // provider must not turn a pending embedding into an unbounded retry loop.
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, pollMs);
      wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    });
  }
} finally {
  await database.close();
  await gate.close();
}
