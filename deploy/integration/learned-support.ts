import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeProviderObservations, verifyProviderUsageTotals, type ProviderObservation } from '../direct-provider-observer.mjs';

/** Reserve before any billable work. Never unlink another process's replacement. */
export async function reserveEvidence(path: string) {
  const destination = resolve(path);
  const file = await open(destination, 'wx+', 0o600);
  const identity = await file.stat();
  const same = (stat: { dev: number; ino: number }) => stat.dev === identity.dev && stat.ino === identity.ino;
  return {
    identity: { path: destination, dev: identity.dev, ino: identity.ino },
    async publish(serialized: string, signal: AbortSignal) {
      signal.throwIfAborted();
      assert(same(await lstat(destination)), 'Evidence reservation was replaced');
      const expected = Buffer.from(serialized);
      await file.truncate(0);
      let written = 0;
      while (written < expected.length) {
        const { bytesWritten } = await file.write(expected, written, expected.length - written, written);
        assert(bytesWritten > 0, 'Evidence publication did not advance');
        written += bytesWritten;
      }
      await file.truncate(expected.length);
      await file.sync();
      signal.throwIfAborted();
      assert(same(await lstat(destination)), 'Evidence reservation was replaced');
      const actual = Buffer.alloc(expected.length + 1);
      let read = 0;
      while (read < actual.length) {
        const { bytesRead } = await file.read(actual, read, actual.length - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      assert.equal((await file.stat()).size, expected.length, 'Evidence publication length changed');
      assert.deepEqual(actual.subarray(0, read), expected, 'Evidence publication bytes changed');
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

/** Verify all recorded implementation bytes in the private running snapshot. */
export async function verifyLearnedSnapshot(root: string, source: { files: Record<string, string> }) {
  for (const [path, expected] of Object.entries(source.files)) {
    assert.equal(createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'), expected, 'Snapshot bytes changed during validation');
  }
}

/** Tags can change on a shared daemon. Inspect the running container instead. */
export async function inspectLearnedContainerImage(service: string, compose: (args: string[]) => Promise<string>, docker: (args: string[]) => Promise<string>) {
  const container = await compose(['ps', '--quiet', service]);
  assert.match(container, /^[0-9a-f]{64}$/, 'Expected exactly one native service container');
  const image = await docker(['container', 'inspect', container, '--format', '{{.Image}}']);
  assert.match(image, /^sha256:[0-9a-f]{64}$/, 'Container omitted its immutable image identity');
  const digests = JSON.parse(await docker(['image', 'inspect', image, '--format', '{{json .RepoDigests}}'])) ?? [];
  assert(Array.isArray(digests) && digests.every(digest => typeof digest === 'string' && /^[^\s@]+@sha256:[0-9a-f]{64}$/.test(digest)), 'Invalid repository digest metadata');
  return { image, repository_digests: digests as string[] };
}

export function verifyLearnedApplicationImages(builtImage: string, apiImage: string, workerImage: string) {
  assert.match(builtImage, /^sha256:[0-9a-f]{64}$/, 'Build omitted its immutable image identity');
  assert.equal(apiImage, builtImage, 'API image differs from the recorded archive build');
  assert.equal(workerImage, builtImage, 'Worker image differs from the recorded archive build');
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
    assert(item.usage_invalid !== true, 'Provider reported invalid raw usage counts');
    verifyProviderUsageTotals(item);
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
