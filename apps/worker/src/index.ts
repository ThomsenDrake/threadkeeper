import { createStore } from '../../../packages/core/src/index.ts';
import { connectDatabase } from '../../../packages/core/src/db.ts';
import { createProvider } from '@threadkeeper/providers';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pollMs = Number(process.env.WORKER_POLL_MS || '1000');
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('WORKER_POLL_MS must be between 100 and 60000');

const database = connectDatabase(databaseUrl);
const store = createStore(database);
const provider = createProvider();
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; wake?.(); });
}

// One job in flight per process. Database claiming prevents independent workers
// from sharing a job; database reconciliation rechecks edits/deletions on commit.
try {
  console.info(JSON.stringify({ event: 'worker_started', model: provider.config.modelId }));
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
        continue;
      }
    } catch {
      console.error(JSON.stringify({ event: 'worker_iteration_failed' }));
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, pollMs);
      wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    });
  }
} finally {
  await database.close();
}
