import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  archiveOpenCodeSource, copyOpenCodeBinary, openCodeEnvironment, parseOpenCodeArguments,
  prepareOpenCodeDependencies, runOpenCodeChild, runOpenCodeProcess, verifyOpenCodeSource,
} from '../deploy/opencode-run.mjs';

const syntheticKey = 'synthetic-fixture-only-credential';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const gitAt = (root: string) => (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
async function initialize(root: string) {
  await mkdir(root, { recursive: true });
  const git = gitAt(root);
  git('init'); git('config', 'user.name', 'Synthetic host fixture'); git('config', 'user.email', 'fixture@example.invalid');
  return git;
}

test('OpenCode bootstrap requires explicit live, exact clean source, and verifies the archived bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-source-test-'));
  const root = join(directory, 'repository');
  try {
    const git = await initialize(root);
    await writeFile(join(root, 'runner.mjs'), 'export const source = "original";\n');
    await writeFile(join(root, 'README.md'), 'Recorded documentation\n');
    git('add', '.'); git('commit', '-m', 'Source fixture');
    const expected = git('rev-parse', 'HEAD');
    const args = ['--source-ref', expected, '--binary', '/synthetic/opencode', '--output', '/synthetic/result.json', '--live'];
    assert.equal(parseOpenCodeArguments(args).sourceRef, expected);
    assert.throws(() => parseOpenCodeArguments(args.slice(0, -1)), /Usage/);
    assert.throws(() => parseOpenCodeArguments(['--source-ref', 'HEAD', ...args.slice(2)]), /exact/);
    assert.throws(() => parseOpenCodeArguments(['--source-ref', expected, '--source-ref', expected, '--output', '/synthetic/result.json', '--live']), /Duplicate/);
    await assert.rejects(archiveOpenCodeSource(root, join(directory, 'wrong'), '0'.repeat(40)), /differs from HEAD/);
    await writeFile(join(root, 'README.md'), 'Uncommitted documentation\n');
    await assert.rejects(archiveOpenCodeSource(root, join(directory, 'dirty'), expected), /Commit source changes/);
    git('restore', 'README.md');
    await writeFile(join(root, 'new.mjs'), 'untracked\n');
    await assert.rejects(archiveOpenCodeSource(root, join(directory, 'untracked'), expected), /Commit source changes/);
    await rm(join(root, 'new.mjs'));
    const archive = join(directory, 'archive'), source = await archiveOpenCodeSource(root, archive, expected);
    await writeFile(join(root, 'runner.mjs'), 'export const source = "concurrent edit";\n');
    git('add', '.'); git('commit', '-m', 'Concurrent edit');
    assert.notEqual(git('rev-parse', 'HEAD'), source.commit);
    await verifyOpenCodeSource(archive, source);
    assert.equal(await readFile(join(archive, 'runner.mjs'), 'utf8'), 'export const source = "original";\n');
    await writeFile(join(archive, 'runner.mjs'), 'snapshot tamper\n');
    await assert.rejects(verifyOpenCodeSource(archive, source), /Snapshot bytes changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OpenCode preparation strips provider credentials and privately copies a verified executable before execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-binary-test-'));
  const fixture = '#!/bin/sh\ntest -z "$NEBIUS_API_KEY" || exit 50\ntest -z "$MODEL_API_KEY" || exit 51\nprintf "1.18.34\\n"\n';
  const environment = { ...process.env, NEBIUS_API_KEY: syntheticKey, MODEL_API_KEY: 'other-synthetic-key', OPENCODE_CONFIG: '/caller/config.json', GITHUB_TOKEN: 'irrelevant-synthetic-token', AWS_ACCESS_KEY_ID: 'synthetic-access-id', AWS_SECRET_ACCESS_KEY: 'synthetic-secret', NODE_OPTIONS: '--synthetic-unsafe-preload', HTTPS_PROXY: 'http://proxy.invalid', NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS };
  try {
    const isolated = openCodeEnvironment(environment);
    assert.equal(isolated.NEBIUS_API_KEY, undefined); assert.equal(isolated.MODEL_API_KEY, undefined);
    assert.equal(isolated.NODE_OPTIONS, undefined); assert.equal(isolated.OPENCODE_CONFIG, undefined); assert.equal(isolated.GITHUB_TOKEN, undefined); assert.equal(isolated.AWS_ACCESS_KEY_ID, undefined); assert.equal(isolated.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(isolated.HTTPS_PROXY, environment.HTTPS_PROXY);
    assert.equal(isolated.NODE_EXTRA_CA_CERTS, environment.NODE_EXTRA_CA_CERTS);
    const execution = openCodeEnvironment(environment, true);
    assert.equal(execution.NEBIUS_API_KEY, syntheticKey); assert.equal(execution.MODEL_API_KEY, undefined);
    const binary = join(directory, 'fixture'); await writeFile(binary, fixture, { mode: 0o700 });
    await assert.rejects(copyOpenCodeBinary(binary, join(directory, 'invalid'), new AbortController().signal, environment), /checksum/);
    const copy = await copyOpenCodeBinary(binary, join(directory, 'private'), new AbortController().signal, environment, digest(fixture));
    await writeFile(binary, 'concurrently changed caller binary');
    assert.equal(copy.version, '1.18.34');
    assert.equal(digest(await readFile(copy.path)), digest(fixture));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OpenCode child uses archived code and private frozen dependencies without exposing credentials to installation', { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-import-test-'));
  const root = join(directory, 'repository'), archive = join(directory, 'archive');
  try {
    const git = await initialize(root);
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'deploy/opencode-child.mjs', 'deploy/integration/learned-run.mjs']) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await copyFile(resolve(path), join(root, path));
    }
    const installer = join(root, 'deploy/integration/learned-run.mjs');
    await writeFile(installer, await readFile(installer, 'utf8') + '\nassert.equal(process.env.NEBIUS_API_KEY, undefined); assert.equal(process.env.MODEL_API_KEY, undefined);\n');
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await writeFile(join(root, 'deploy/helper.ts'), 'export const value = "archived-helper";\n');
    await writeFile(join(root, 'deploy/host-supervisor.mjs'), `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid)); process.on('SIGTERM', () => {});
spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", process.argv[2] + '.descendant'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\n`);
    await writeFile(join(root, 'deploy/opencode-execute.ts'), `import assert from 'node:assert/strict'; import { spawn } from 'node:child_process'; import { readFile, writeFile } from 'node:fs/promises'; import { resolve } from 'node:path'; import { z } from 'zod'; import { value } from './helper.ts';
export async function runOpenCodeLifecycle(options) {
  assert.equal(process.env.NEBIUS_API_KEY, ${JSON.stringify(syntheticKey)}); assert.equal(process.env.MODEL_API_KEY, undefined); options.signal.throwIfAborted();
  if (['crash.json', 'orphan.json', 'cancel.json', 'closed.json'].some(name => options.output.endsWith(name))) {
    const host = spawn(process.execPath, [resolve(options.root, 'deploy/host-supervisor.mjs'), options.output + '.pid'], { detached: true, stdio: 'ignore' }); host.unref();
    await new Promise((resolveAck, reject) => {
      const timer = setTimeout(() => reject(new Error('Parent did not acknowledge host tracking')), 2000);
      const receive = message => { if (message?.event === 'opencode_host_tracked' && message.pid === host.pid) { clearTimeout(timer); process.off('message', receive); resolveAck(); } };
      process.on('message', receive); process.send({ event: 'opencode_host_started', pid: host.pid });
    });
    for (let attempt = 0; attempt < 100; attempt++) { try { await readFile(options.output + '.pid.descendant'); break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); } }
    if (options.output.endsWith('closed.json')) await new Promise((resolveAck, reject) => { const timer = setTimeout(() => reject(new Error('Parent did not acknowledge host cleanup')), 2000); const receive = message => { if (message?.event === 'opencode_host_untracked' && message.pid === host.pid) { clearTimeout(timer); process.off('message', receive); resolveAck(); } }; process.on('message', receive); process.send({ event: 'opencode_host_closed', pid: host.pid }); });
    if (options.output.endsWith('crash.json')) process.exit(7);
    if (options.output.endsWith('cancel.json')) { const keepAlive = setInterval(() => {}, 1000); try { if (!options.signal.aborted) await new Promise(resolveAbort => options.signal.addEventListener('abort', resolveAbort, { once: true })); options.signal.throwIfAborted(); } finally { clearInterval(keepAlive); } }
  }
  await writeFile(options.output, JSON.stringify({ value: z.string().parse(value), commit: options.source.commit }));
}\n`);
    git('add', '.'); git('commit', '-m', 'Archived private host fixture');
    const source = await archiveOpenCodeSource(root, archive, git('rev-parse', 'HEAD'));
    const environment = { ...process.env, NEBIUS_API_KEY: syntheticKey, MODEL_API_KEY: 'unused-synthetic-key' };
    const signal = new AbortController().signal;
    const installation = await prepareOpenCodeDependencies(archive, directory, source, signal, environment, process.cwd());
    assert.equal(installation.evidence.installation, 'private_offline_frozen_copy_ignore_scripts');
    assert.equal(installation.evidence.lockfile_sha256, source.files['pnpm-lock.yaml']);
    await writeFile(join(root, 'deploy/helper.ts'), 'throw new Error("mutable source loaded");\n');
    await mkdir(join(root, 'node_modules/zod'), { recursive: true });
    await writeFile(join(root, 'node_modules/zod/package.json'), '{"name":"zod","type":"module","main":"index.js"}');
    await writeFile(join(root, 'node_modules/zod/index.js'), 'throw new Error("mutable dependency loaded");\n');
    const fixture = '#!/bin/sh\nprintf "1.18.34\\n"\n';
    const binaryPath = join(directory, 'fixture'); await writeFile(binaryPath, fixture, { mode: 0o700 });
    const binary = await copyOpenCodeBinary(binaryPath, join(directory, 'private-binary'), signal, environment, digest(fixture));
    const output = join(directory, 'result.json');
    await runOpenCodeChild({ root: archive, directory, source, output, binary, host_dependencies: installation.evidence }, installation, signal, environment);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { value: 'archived-helper', commit: source.commit });
    await t.test('registered supervisor process groups are cleaned up', {
      skip: process.platform !== 'linux' && 'Supervisor registration requires Linux /proc',
    }, async () => {
      // The outer bootstrap owns registered process groups independently of the
      // executor's normal finally: cover fatal exit and a returned orphan alike.
      for (const outcome of ['crash', 'orphan', 'cancel', 'closed']) {
        const executionDirectory = join(directory, outcome); await mkdir(executionDirectory);
        const executionOutput = join(executionDirectory, `${outcome}.json`);
        const executionAbort = new AbortController();
        const operation = runOpenCodeChild({ root: archive, directory: executionDirectory, source, output: executionOutput,
          binary, host_dependencies: installation.evidence }, installation, executionAbort.signal, environment);
        if (outcome === 'cancel') {
          const rejected = assert.rejects(operation, /preparation or validation failed/);
          for (let attempt = 0; attempt < 100; attempt++) {
            try { await readFile(executionOutput + '.pid.descendant'); break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
          }
          executionAbort.abort(); await rejected;
        } else if (outcome === 'crash') await assert.rejects(operation, /preparation or validation failed/);
        else if (outcome === 'orphan') await assert.rejects(operation, /active host process groups/);
        else await operation;
        for (const suffix of ['.pid', '.pid.descendant']) {
          const pid = Number(await readFile(executionOutput + suffix, 'utf8'));
          let exited = false;
          for (let attempt = 0; attempt < 50 && !exited; attempt++) {
            try { process.kill(pid, 0); exited = /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8')); }
            catch (error) { exited = ['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''); }
            if (!exited) await new Promise(resolveWait => setTimeout(resolveWait, 20));
          }
          assert(exited, `Registered ${outcome} host process must not survive outer cleanup`);
        }
      }
    });
  } finally {
    for (const outcome of ['crash', 'orphan', 'cancel', 'closed']) {
      try { const pid = Number(await readFile(join(directory, outcome, outcome + '.json.pid'), 'utf8')); process.kill(-pid, 'SIGKILL'); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const detachedStdio of [false, true]) test(`OpenCode cancellation removes hanging preparation descendants with detached stdio=${detachedStdio}`, { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadkeeper-opencode-abort-test-'));
  const marker = join(directory, 'grandchild.pid'), abort = new AbortController();
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio:${JSON.stringify(detachedStdio ? 'ignore' : 'inherit')} }); ${detachedStdio ? '' : "process.on('SIGTERM', () => {});"} setInterval(() => {}, 1000);`;
  let pid: number | undefined;
  try {
    const operation = runOpenCodeProcess(process.execPath, ['-e', parent], { cwd: directory, environment: openCodeEnvironment(process.env), signal: abort.signal, killAfterMs: 100 });
    const rejected = assert.rejects(operation, /preparation or validation failed/);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(marker, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert(pid, 'Preparation descendant should start before cancellation');
    abort.abort(); await rejected;
    let exited = false;
    try { process.kill(pid, 0); exited = /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8')); }
    catch (error) { exited = ['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''); }
    assert(exited, 'Cancelled preparation descendant must not continue running');
  } finally {
    abort.abort();
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
