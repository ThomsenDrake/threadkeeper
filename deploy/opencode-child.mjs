import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const [mode, manifestPath] = process.argv.slice(2);
  assert(['prepare', 'execute'].includes(mode), 'Invalid private host process mode');
  const options = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cancellation = new AbortController();
  const interrupt = () => { process.exitCode = 1; cancellation.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  process.stdout.on('error', interrupt); process.stderr.on('error', interrupt);
  if (mode === 'prepare') {
    const { installLearnedDependencies } = await import(pathToFileURL(resolve(options.root, 'deploy/integration/learned-run.mjs')).href);
    const installation = await installLearnedDependencies(options.root, cancellation.signal, options.cacheContext);
    cancellation.signal.throwIfAborted();
    await writeFile(options.installationFile, JSON.stringify(installation), { flag: 'wx', mode: 0o600 });
  } else {
    const { runOpenCodeLifecycle } = await import(pathToFileURL(resolve(options.root, 'deploy/opencode-execute.ts')).href);
    await runOpenCodeLifecycle({ ...options, signal: cancellation.signal });
    cancellation.signal.throwIfAborted();
  }
}
try { await main(); }
catch { process.exitCode = 1; console.error('FAIL: private OpenCode child preparation or execution failed'); }
finally { if (process.connected) process.disconnect(); }
