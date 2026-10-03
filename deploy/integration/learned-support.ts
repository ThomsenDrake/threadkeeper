import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeProviderObservations, type ProviderObservation } from '../direct-provider-observer.mjs';

/** Reserve before any billable work. Never unlink another process's replacement. */
export async function reserveEvidence(path: string) {
  const destination = resolve(path);
  const file = await open(destination, 'wx', 0o600);
  const identity = await file.stat();
  const same = (stat: { dev: number; ino: number }) => stat.dev === identity.dev && stat.ino === identity.ino;
  return {
    async publish(serialized: string, signal: AbortSignal) {
      signal.throwIfAborted();
      assert(same(await lstat(destination)), 'Evidence reservation was replaced');
      await file.writeFile(serialized);
      await file.sync();
      signal.throwIfAborted();
      assert(same(await lstat(destination)), 'Evidence reservation was replaced');
    },
    close: () => file.close(),
    async discard() {
      try { if (same(await lstat(destination))) await rm(destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
    discardSync() {
      try { if (same(lstatSync(destination))) rmSync(destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
  };
}

/** Docker and Compose read only a private archive of the recorded commit. */
export async function archiveLearnedSource(root: string, destination: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const implementation = (path: string) => path && !path.startsWith('docs/') && !path.endsWith('.md');
  const implementationFiles = git('ls-files', '-z').split('\0').filter(implementation);
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...implementationFiles), '', 'Commit source changes before live validation');
  assert.deepEqual(git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(implementation), [], 'Commit new implementation files before live validation');
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${commit}^{tree}`);
  await mkdir(destination, { mode: 0o700 });
  const archive = resolve(destination, '../source.tar');
  try {
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: root });
    execFileSync('tar', ['-xf', archive, '-C', destination]);
  } finally { await rm(archive, { force: true }); }
  const files = Object.fromEntries(await Promise.all(implementationFiles.map(async path => [path,
    createHash('sha256').update(await readFile(resolve(destination, path))).digest('hex')])));
  return { commit, tree, files };
}

/** Host scenario modules are loaded once; reject concurrent edits or commits. */
export async function verifyLearnedSource(root: string, source: { commit: string; files: Record<string, string> }) {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), source.commit, 'Source commit changed during validation');
  for (const [path, expected] of Object.entries(source.files)) {
    assert.equal(createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'), expected, 'Source bytes changed during validation');
  }
}

export type LearnedObservation = ProviderObservation & { service: 'api' | 'worker' };
export function parseLearnedObservations(logs: string, service: LearnedObservation['service']): LearnedObservation[] {
  return logs.split('\n').flatMap(line => {
    try { const parsed = JSON.parse(line); return parsed.event === 'direct_provider_request' ? [{ ...parsed, service }] : []; }
    catch { return []; }
  });
}

/** Fail closed if one process's billed attempts or verified identity is missing. */
export function verifyLearnedObservations(observations: LearnedObservation[]) {
  for (const item of observations) {
    assert(item.sent && item.http_status === 200, 'A provider request failed or exceeded its budget');
    assert(['chat/completions', 'embeddings'].includes(item.path), 'Unexpected provider request path');
    const expected = item.path === 'chat/completions' ? 'nvidia/Nemotron-3_5-Lightning' : 'Qwen/Qwen3-Embedding-8B';
    assert.equal(item.requested_model, expected, 'Unexpected requested provider model');
    assert.equal(item.returned_model_matches, true, 'Provider returned model identity was not verified');
  }
  const api = observations.filter(item => item.service === 'api');
  const worker = observations.filter(item => item.service === 'worker');
  assert.equal(api.length + worker.length, observations.length, 'Unknown provider observation process');
  for (const records of [api, worker]) assert.deepEqual(records.map(item => item.ordinal), records.map((_, index) => index + 1), 'Provider process observations missing or duplicated');
  assert.equal(api.filter(item => item.path === 'chat/completions').length, 0, 'API unexpectedly extracted context');
  assert.equal(api.filter(item => item.path === 'embeddings').length, 5, 'Expected all five API query embedding requests');
  assert.equal(worker.filter(item => item.path === 'embeddings').length, 2, 'Expected both worker indexing requests');
  const chat = worker.filter(item => item.path === 'chat/completions').length;
  assert(chat === 1 || chat === 2, 'Expected one extraction with at most one repair');
  const summary = summarizeProviderObservations(observations);
  assert(summary.usage_complete, 'Provider usage accounting incomplete');
  return summary;
}

/** A failure in one teardown phase must not prevent later evidence or cleanup. */
export async function settleLearnedCleanup(steps: Array<() => Promise<unknown>>) {
  const failures: unknown[] = [];
  for (const step of steps) { try { await step(); } catch (error) { failures.push(error); } }
  return failures;
}
