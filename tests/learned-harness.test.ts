import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { archiveLearnedSource, loadLearnedExecutor } from '../deploy/integration/learned-run.ts';
import { inspectLearnedContainerImage, parseLearnedObservations, reserveEvidence, settleLearnedCleanup, verifyLearnedObservations, verifyLearnedSnapshot, type LearnedObservation } from '../deploy/integration/learned-support.ts';

const model = 'nvidia/Nemotron-3_5-Lightning';
const embedding = 'Qwen/Qwen3-Embedding-8B';
const record = (service: 'api' | 'worker', ordinal: number, path = 'embeddings'): LearnedObservation => ({
  event: 'direct_provider_request', service, ordinal, path, method: 'POST', started_at: '2026-10-03T00:00:00.000Z',
  sent: true, elapsed_ms: 1, outcome: 'http_response', usage_status: 'reported', http_status: 200,
  requested_model: path === 'embeddings' ? embedding : model, returned_model_matches: true, usage: { total_tokens: 10 },
});
const observations = () => [
  ...Array.from({ length: 5 }, (_, i) => record('api', i + 1)),
  record('worker', 1, 'chat/completions'), record('worker', 2), record('worker', 3),
];

test('native acceptance requires complete distinct per-process attempts and verified requested/returned models', () => {
  assert.equal(verifyLearnedObservations(observations()).usage.total_tokens, 80);
  const repaired = observations();
  repaired.splice(6, 0, record('worker', 2, 'chat/completions'));
  repaired[7].ordinal = 3; repaired[8].ordinal = 4;
  assert.equal(verifyLearnedObservations(repaired).inference_request_count, 9);
  assert.throws(() => verifyLearnedObservations(observations().filter(item => item.service === 'worker')), /five API/);
  assert.throws(() => verifyLearnedObservations(observations().filter((_, i) => i !== 7)), /both worker/);
  for (const matches of [undefined, false]) {
    const records = observations(); records[0].returned_model_matches = matches;
    assert.throws(() => verifyLearnedObservations(records), /identity was not verified/);
  }
  const wrong = observations(); wrong[0].requested_model = model;
  assert.throws(() => verifyLearnedObservations(wrong), /requested provider model/);
  const duplicated = observations(); duplicated[1] = duplicated[0];
  assert.throws(() => verifyLearnedObservations(duplicated), /missing or duplicated/);
  const absentUsage = observations(); delete absentUsage[3].usage;
  assert.throws(() => verifyLearnedObservations(absentUsage), /usage accounting incomplete/);
  const extra = observations(); extra.splice(5, 0, record('api', 6));
  assert.throws(() => verifyLearnedObservations(extra), /five API/);
});

test('log collection and local credential removal still run after stop, log and Docker failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-harness-cleanup-'));
  const secret = join(directory, '.env');
  await writeFile(secret, 'BOOTSTRAP_PASSWORD=synthetic-private-password\n', { mode: 0o600 });
  const events: string[] = [];
  const records: LearnedObservation[] = [];
  const failures = await settleLearnedCleanup([
    async () => { events.push('stop'); throw new Error('synthetic stop failed'); },
    async () => { events.push('api logs'); throw new Error('synthetic api logs failed'); },
    async () => { events.push('worker logs'); records.push(...parseLearnedObservations('startup\n' + JSON.stringify(record('worker', 1, 'chat/completions')), 'worker')); },
    async () => { events.push('Docker down'); throw new Error('synthetic Docker down failed'); },
    async () => { events.push('credentials'); await rm(directory, { recursive: true, force: true }); },
  ]);
  assert.deepEqual(events, ['stop', 'api logs', 'worker logs', 'Docker down', 'credentials']);
  assert.equal(failures.length, 3);
  assert.equal(records.length, 1);
  assert.equal(records[0].service, 'worker');
  await assert.rejects(readFile(secret), { code: 'ENOENT' });
});

test('exclusive evidence reservation rejects competing writers before work and discards aborted publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-harness-output-'));
  const destination = join(directory, 'evidence.json');
  let reservation: Awaited<ReturnType<typeof reserveEvidence>> | undefined;
  try {
    reservation = await reserveEvidence(destination);
    await assert.rejects(reserveEvidence(destination), { code: 'EEXIST' });
    await assert.rejects(writeFile(destination, 'competing result', { flag: 'wx' }), { code: 'EEXIST' });
    const signal = new AbortController(); signal.abort();
    await assert.rejects(reservation.publish('{"result":"PASS"}', signal.signal), { name: 'AbortError' });
    await reservation.discard(); await reservation.close(); reservation = undefined;
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    reservation = await reserveEvidence(destination);
    await reservation.publish('{"result":"PASS"}', new AbortController().signal);
    assert.equal(await readFile(destination, 'utf8'), '{"result":"PASS"}');
    reservation.discardSync();
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  } finally { await reservation?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('replaced output reservations fail publication without overwriting or removing the replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-harness-replacement-'));
  const destination = join(directory, 'evidence.json');
  const reservation = await reserveEvidence(destination);
  try {
    await rm(destination); await writeFile(destination, 'unrelated result');
    await assert.rejects(reservation.publish('{"result":"PASS"}', new AbortController().signal), /reservation was replaced/);
    await reservation.discard(); reservation.discardSync();
    assert.equal(await readFile(destination, 'utf8'), 'unrelated result');
  } finally { await reservation.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native build context preserves committed bytes despite source edits and detects snapshot tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-harness-source-'));
  const repository = join(directory, 'repository'), archive = join(directory, 'archive');
  await mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' }).toString().trim();
  try {
    git('init'); git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'synthetic@example.invalid');
    await mkdir(join(repository, 'deploy'));
    await writeFile(join(repository, 'deploy/Dockerfile'), 'FROM synthetic:original\n');
    await writeFile(join(repository, 'deploy/compose.yaml'), 'services: {}\n');
    git('add', '.'); git('commit', '-m', 'Synthetic source snapshot');
    const source = await archiveLearnedSource(repository, archive);
    await verifyLearnedSnapshot(archive, source);
    await writeFile(join(repository, 'deploy/Dockerfile'), 'FROM synthetic:changed\n');
    assert.equal(await readFile(join(archive, 'deploy/Dockerfile'), 'utf8'), 'FROM synthetic:original\n');
    assert.equal(source.files['deploy/Dockerfile'], createHash('sha256').update('FROM synthetic:original\n').digest('hex'));
    await verifyLearnedSnapshot(archive, source);
    git('add', '.'); git('commit', '-m', 'Concurrent synthetic edit');
    assert.notEqual(git('rev-parse', 'HEAD'), source.commit);
    await writeFile(join(archive, 'deploy/Dockerfile'), 'FROM synthetic:tampered\n');
    await assert.rejects(verifyLearnedSnapshot(archive, source), /Snapshot bytes changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('entire native runner, scenario and validation helpers execute from the recorded archive despite a concurrent commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-harness-import-'));
  const repository = join(directory, 'repository'), archive = join(directory, 'archive');
  await mkdir(join(repository, 'deploy/integration'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  try {
    await writeFile(join(repository, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(repository, 'deploy/integration/learned-execute.ts'), "import { runLearnedScenarios } from './learned-scenarios.ts'; import { value } from './local-helper.ts'; export async function runLearnedLifecycle() { return 'recorded runner: ' + await runLearnedScenarios() + ': ' + value; }\n");
    await writeFile(join(repository, 'deploy/integration/learned-scenarios.ts'), "import { value } from './local-helper.ts'; import { z } from 'zod'; export async function runLearnedScenarios() { return z.string().parse(value); }\n");
    await writeFile(join(repository, 'deploy/integration/local-helper.ts'), "export const value = 'recorded scenario helper';\n");
    git('init'); git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'synthetic@example.invalid');
    git('add', '.'); git('commit', '-m', 'Recorded synthetic scenario');
    const source = await archiveLearnedSource(repository, archive);
    await writeFile(join(repository, 'deploy/integration/local-helper.ts'), "export const value = 'different current helper';\n");
    await writeFile(join(repository, 'deploy/integration/learned-scenarios.ts'), "export async function runLearnedScenarios() { return 'different current scenario'; }\n");
    await writeFile(join(repository, 'deploy/integration/learned-execute.ts'), "export async function runLearnedLifecycle() { return 'different current runner'; }\n");
    git('add', '.'); git('commit', '-m', 'Concurrent synthetic scenario edit');
    const executor = await loadLearnedExecutor(archive, resolve('node_modules'));
    assert.equal(await executor.runLearnedLifecycle(), 'recorded runner: recorded scenario helper: recorded scenario helper');
    await assert.rejects(readFile(join(archive, 'node_modules/package.json')), { code: 'ENOENT' });
    await verifyLearnedSnapshot(archive, source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native image evidence follows the service container immutable ID even without a repository digest', async () => {
  const container = 'a'.repeat(64), image = 'sha256:' + 'b'.repeat(64);
  const commands: string[][] = [];
  const compose = async (args: string[]) => { assert.deepEqual(args, ['ps', '--quiet', 'postgres']); return container; };
  for (const digests of [[], ['pgvector/pgvector@sha256:' + 'c'.repeat(64)]]) {
    const actual = await inspectLearnedContainerImage('postgres', compose, async args => {
      commands.push(args);
      if (args[0] === 'container') { assert.deepEqual(args, ['container', 'inspect', container, '--format', '{{.Image}}']); return image; }
      assert.deepEqual(args, ['image', 'inspect', image, '--format', '{{json .RepoDigests}}']);
      return JSON.stringify(digests);
    });
    assert.deepEqual(actual, { image, repository_digests: digests });
  }
  assert(commands.every(args => !args.includes('pgvector/pgvector:pg17')), 'Mutable tag must never establish the running image');
  await assert.rejects(inspectLearnedContainerImage('postgres', compose, async () => ''), /immutable image identity/);
  await assert.rejects(inspectLearnedContainerImage('postgres', async () => container + '\n' + container, async () => image), /exactly one/);
});

test('actual runner removes reserved evidence and credentials despite unavailable Docker and a closed stderr pipe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-harness-process-'));
  const repository = join(directory, 'repository'), bin = join(directory, 'bin');
  await mkdir(join(repository, 'deploy/integration'), { recursive: true });
  await mkdir(bin);
  try {
    for (const path of ['deploy/integration/learned-run.ts', 'deploy/integration/learned-execute.ts', 'deploy/integration/learned-support.ts', 'deploy/direct-provider-observer.mjs']) {
      await copyFile(resolve(path), join(repository, path));
    }
    await writeFile(join(repository, 'deploy/integration/learned-scenarios.ts'), 'export async function runLearnedScenarios() { throw new Error("No scenario or provider call permitted"); }\n');
    await writeFile(join(repository, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(repository, '.gitignore'), 'node_modules\n');
    await symlink(resolve('node_modules'), join(repository, 'node_modules'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'synthetic@example.invalid');
    git('add', '.'); git('commit', '-m', 'Synthetic runner fixture');
    await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HARNESS_TEST_TRACE, JSON.stringify(args) + '\\n');
if (args.includes('logs')) {
  process.stdout.write(JSON.stringify({ event: 'direct_provider_request', ordinal: 1, path: 'embeddings', sent: true, http_status: 200, usage: { total_tokens: 10 } }) + '\\n');
} else if (args.includes('info') || args.includes('stop') || args.includes('down')) {
  process.stderr.write('Synthetic Docker unavailable\\n'); process.exitCode = 17;
}
`, { mode: 0o700 });
    for (const [variant, closeStderr] of [['external', false], ['closed-stderr', true], ['repository-local', false], ['missing-output', false]] as const) {
      const trace = join(directory, `commands-${variant}.ndjson`), evidence = join(variant === 'repository-local' ? repository : directory, `evidence-${variant}.json`);
      const child = spawn(process.execPath, ['--import', 'tsx', 'deploy/integration/learned-run.ts', ...(variant === 'missing-output' ? [] : [evidence])], {
        cwd: repository,
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, NEBIUS_API_KEY: 'synthetic-harness-secret', HARNESS_TEST_TRACE: trace },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (closeStderr && stdout.includes('Direct learned native lifecycle:')) child.stderr.destroy();
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal }));
      }).finally(() => clearTimeout(timer));
      assert.deepEqual(exit, { code: 1, signal: null });
      if (variant === 'missing-output') {
        assert(stderr.includes('destination required'));
        await assert.rejects(readFile(trace), { code: 'ENOENT' });
        await assert.rejects(readFile(evidence), { code: 'ENOENT' });
        continue;
      }
      const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
      assert(commands.some(args => args.includes('stop')));
      assert(commands.some(args => args.includes('logs') && args.at(-1) === 'api'));
      assert(commands.some(args => args.includes('logs') && args.at(-1) === 'worker'));
      assert(commands.some(args => args.includes('down')));
      const compose = commands.find(args => args.includes('--env-file'))!;
      await assert.rejects(readFile(compose[compose.indexOf('--env-file') + 1]), { code: 'ENOENT' });
      await assert.rejects(readFile(join(dirname(compose[compose.indexOf('--env-file') + 1]), 'source/package.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(evidence), { code: 'ENOENT' });
      assert(!stdout.includes('PASS')); assert(!stdout.includes('synthetic-harness-secret')); assert(!stderr.includes('synthetic-harness-secret'));
      if (!closeStderr) {
        const failure = JSON.parse(stderr.trim().split('\n').at(-1)!);
        assert.equal(failure.result, 'FAIL');
        assert.deepEqual(failure.provider_requests.map((item: LearnedObservation) => item.service), ['api', 'worker']);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
