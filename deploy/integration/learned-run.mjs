import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Built-in-only bootstrap. Operational TypeScript and dependencies are loaded
// exclusively by a separate Node process after a private frozen installation.
export async function archiveLearnedSource(root, destination) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const implementation = (path) => path && !path.startsWith('docs/') && !path.endsWith('.md');
  const implementationFiles = git('ls-files', '-z').split('\0').filter(implementation);
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...implementationFiles), '', 'Commit source changes before live validation');
  assert.deepEqual(git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(implementation), [], 'Commit new implementation files before live validation');
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', `${commit}^{tree}`);
  // Read the list from the captured commit, not an index that could change.
  const filesAtCommit = git('ls-tree', '-r', '--name-only', '-z', commit).split('\0').filter(implementation);
  await mkdir(destination, { mode: 0o700 });
  const archive = resolve(destination, '../source.tar');
  try {
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: root });
    execFileSync('tar', ['-xf', archive, '-C', destination]);
  } finally { await rm(archive, { force: true }); }
  const files = Object.fromEntries(await Promise.all(filesAtCommit.map(async path => [path,
    createHash('sha256').update(await readFile(resolve(destination, path))).digest('hex')])));
  return { commit, tree, files };
}

function isolatedEnvironment() {
  const env = { ...process.env, CI: 'true', COREPACK_ENABLE_NETWORK: '0' };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete env[name];
  return env;
}

async function command(executable, args, options) {
  options.signal.throwIfAborted();
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: isolatedEnvironment(),
      stdio: options.inherit ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false, force;
    const stop = () => {
      failed = true;
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), options.inherit ? 12_000 : 1000);
    };
    options.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, options.timeout ?? 180_000);
    child.stdout.on('data', data => { if (options.inherit) process.stdout.write(data); else output = (output + data).slice(-6000); });
    child.stderr.on('data', data => { if (options.inherit) process.stderr.write(data); });
    child.on('message', message => options.onMessage?.(message));
    const clear = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal.removeEventListener('abort', stop); };
    child.once('error', error => { clear(); reject(error); });
    child.once('close', code => {
      clear();
      if (code === 0 && !failed && !options.signal.aborted) resolveCommand(output.trim());
      else reject(new Error('Private dependency preparation or validation process failed'));
    });
  });
}

export async function installLearnedDependencies(snapshotRoot, signal) {
  const manifest = JSON.parse(await readFile(resolve(snapshotRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.packageManager, 'pnpm@11.25.0', 'Private host installation requires pnpm 11.25.0');
  let executable = 'corepack', prefix = ['pnpm'];
  let version;
  try { version = await command(executable, [...prefix, '--version'], { cwd: snapshotRoot, signal }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    executable = 'pnpm'; prefix = [];
    version = await command(executable, ['--version'], { cwd: snapshotRoot, signal });
  }
  assert.equal(version, '11.25.0', 'Private host installation requires pnpm 11.25.0');
  const lock = await readFile(resolve(snapshotRoot, 'pnpm-lock.yaml'));
  await command(executable, [...prefix, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts',
    '--package-import-method=copy', '--config.verify-store-integrity=true', '--config.manage-package-manager-versions=false'], { cwd: snapshotRoot, signal });
  assert.deepEqual(await readFile(resolve(snapshotRoot, 'pnpm-lock.yaml')), lock, 'Private installation changed the archived lockfile');
  const require = createRequire(resolve(snapshotRoot, 'package.json'));
  const loader = await realpath(require.resolve('tsx'));
  assert(loader.startsWith(resolve(snapshotRoot) + sep), 'Host loader escaped the private installation');
  const tsx = JSON.parse(await readFile(resolve(snapshotRoot, 'node_modules/tsx/package.json'), 'utf8'));
  assert.equal(tsx.version, manifest.devDependencies?.tsx ?? manifest.dependencies?.tsx, 'Private loader version differs from the archived manifest');
  return { loader, evidence: { package_manager: 'pnpm@11.25.0', installation: 'private_offline_frozen_copy_ignore_scripts',
    lockfile_sha256: createHash('sha256').update(lock).digest('hex'), typescript_loader: `tsx@${tsx.version}` } };
}

export async function runLearnedChild(snapshotRoot, manifestPath, installation, signal, onMessage) {
  return await command(process.execPath, ['--import', pathToFileURL(installation.loader).href,
    resolve(snapshotRoot, 'deploy/integration/learned-child.mjs'), manifestPath], {
    cwd: snapshotRoot, signal, inherit: true, timeout: 1500_000, onMessage,
  });
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
  assert(process.argv.length === 3 && process.argv[2], 'Usage: pnpm integration:learned evidence.json (destination required)');
  assert(process.env.NEBIUS_API_KEY, 'Configure NEBIUS_API_KEY without printing it');
  const output = resolve(process.argv[2]);
  const cancellation = new AbortController();
  const interrupt = () => { process.exitCode = 1; cancellation.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  process.stdout.on('error', interrupt); process.stderr.on('error', interrupt);
  let directory, reservation, completed = false;
  const discardReservedEvidence = () => {
    if (!reservation) return;
    try {
      const current = lstatSync(output);
      if (current.dev === reservation.dev && current.ino === reservation.ino) rmSync(output);
    } catch (error) { if (error.code !== 'ENOENT') process.exitCode = 1; }
  };
  process.on('exit', code => { if (code !== 0 || cancellation.signal.aborted || !completed) discardReservedEvidence(); });
  try {
    directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-learned-'));
    const snapshotRoot = resolve(directory, 'source');
    const source = await archiveLearnedSource(root, snapshotRoot);
    const installation = await installLearnedDependencies(snapshotRoot, cancellation.signal);
    const manifestPath = resolve(directory, 'validation.json');
    await writeFile(manifestPath, JSON.stringify({ root: snapshotRoot, directory, source, output, host_dependencies: installation.evidence }), { mode: 0o600 });
    await runLearnedChild(snapshotRoot, manifestPath, installation, cancellation.signal, message => {
      if (message?.event === 'evidence_reserved' && message.path === output && Number.isSafeInteger(message.dev) && Number.isSafeInteger(message.ino)) reservation = message;
    });
    completed = true;
  } catch {
    process.exitCode = 1;
    console.error('FAIL: private native validation preparation or execution failed');
  } finally {
    if (!completed || cancellation.signal.aborted) discardReservedEvidence();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
