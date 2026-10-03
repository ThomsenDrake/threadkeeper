import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bootstrap imports only Node built-ins. The archived child prepares copied,
// locked dependencies before the operational executor is loaded in another process.
export const OPENCODE_VERSION = '1.18.34';
export const OPENCODE_SHA256 = '9ca0b9953d49997601655e54f846a3efa464f237e47c6f1b04716d0f2e64c4c2';
const launcherBytes = readFileSync(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function openCodeEnvironment(environment, includeCredential = false) {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'COREPACK_HOME', 'PNPM_HOME', 'PNPM_STORE_DIR', 'npm_config_store_dir', 'NPM_CONFIG_STORE_DIR',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']);
  const env = { CI: 'true', COREPACK_ENABLE_NETWORK: '0' };
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && (allowed.has(name) || /^LC_[A-Z_]+$/.test(name))) env[name] = value;
  }
  if (includeCredential && environment.NEBIUS_API_KEY) env.NEBIUS_API_KEY = environment.NEBIUS_API_KEY;
  return env;
}

export async function archiveOpenCodeSource(root, destination, expectedCommit) {
  assert.match(expectedCommit, /^[a-f0-9]{40}$/, 'An exact 40-character source commit is required');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  assert.equal(git('rev-parse', 'HEAD'), expectedCommit, 'Expected source commit differs from HEAD');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Commit source changes before host validation');
  const tree = git('rev-parse', `${expectedCommit}^{tree}`);
  const entries = git('ls-tree', '-r', '-z', expectedCommit).split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
    assert(match, 'Host validation requires regular tracked source files');
    return { path: match[3], object: match[2] };
  });
  await mkdir(destination, { mode: 0o700 });
  const archive = resolve(destination, '../source.tar');
  try {
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, expectedCommit], { cwd: root, stdio: 'pipe' });
    execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'pipe' });
  } finally { await rm(archive, { force: true }); }
  const files = {};
  for (const entry of entries) {
    const bytes = await readFile(resolve(destination, entry.path));
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), entry.object, 'Archived source differs from recorded Git object');
    files[entry.path] = digest(bytes);
  }
  const source = { commit: expectedCommit, tree, files };
  await verifyOpenCodeSource(destination, source);
  return source;
}

export async function verifyOpenCodeSource(root, source) {
  for (const [path, hash] of Object.entries(source.files)) {
    assert(path && !isAbsolute(path) && !relative(root, resolve(root, path)).startsWith('..'), 'Source path escaped snapshot');
    const absolute = resolve(root, path);
    assert((await lstat(absolute)).isFile(), 'Snapshot source is not a regular file');
    assert.equal(digest(await readFile(absolute)), hash, 'Snapshot bytes changed');
  }
}

export async function runOpenCodeProcess(executable, args, options) {
  options.signal.throwIfAborted();
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.environment,
      detached: process.platform !== 'win32', stdio: options.forward ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false, force;
    const kill = signal => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') failed = true; }
    };
    const stop = () => {
      failed = true; kill('SIGTERM');
      force ??= setTimeout(() => kill('SIGKILL'), options.killAfterMs ?? 1000);
    };
    options.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, options.timeoutMs ?? 180_000);
    child.stdout.on('data', data => { if (options.forward) process.stdout.write(data); else output = (output + data).slice(-12_000); });
    child.stderr.on('data', data => { if (options.forward) process.stderr.write(data); });
    child.on('message', message => {
      try {
        options.onMessage?.(message, reply => child.send(reply, error => { if (error) stop(); }), child.pid);
      } catch { stop(); }
    });
    const clear = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal.removeEventListener('abort', stop); };
    child.once('error', () => { clear(); reject(new Error('Private host process failed to start')); });
    child.once('close', code => {
      // A leader can exit while a detached-from-stdio descendant ignores TERM.
      // Finish cancelling its process group before discarding the force timer.
      if (failed || options.signal.aborted) kill('SIGKILL');
      clear();
      if (code === 0 && !failed && !options.signal.aborted) resolveCommand(output.trim());
      else reject(new Error('Private host preparation or validation failed'));
    });
  });
}

export async function copyOpenCodeBinary(binaryPath, destination, signal, environment = process.env, expectedSha256 = OPENCODE_SHA256) {
  const actual = await realpath(binaryPath);
  assert((await lstat(actual)).isFile(), 'Host executable is not a regular file');
  const bytes = await readFile(actual);
  assert.equal(digest(bytes), expectedSha256, 'Host executable checksum differs from the pinned binary');
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o700 });
  await chmod(destination, 0o700);
  assert.equal(digest(await readFile(destination)), expectedSha256, 'Private host executable checksum differs');
  const versionEnvironment = openCodeEnvironment(environment);
  for (const kind of ['CONFIG', 'CACHE', 'DATA', 'STATE']) versionEnvironment[`XDG_${kind}_HOME`] = resolve(dirname(destination), `version-${kind.toLowerCase()}`);
  versionEnvironment.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  const version = await runOpenCodeProcess(destination, ['--version'], { cwd: dirname(destination),
    environment: versionEnvironment, signal, timeoutMs: 20_000 });
  assert.equal(version, OPENCODE_VERSION, 'Host executable version differs from the pinned version');
  return { path: destination, sha256: expectedSha256, version };
}

export async function prepareOpenCodeDependencies(root, directory, source, signal, environment = process.env, cacheContext = process.cwd()) {
  await verifyOpenCodeSource(root, source);
  const preparation = resolve(directory, 'preparation.json'), installationFile = resolve(directory, 'installation.json');
  await writeFile(preparation, JSON.stringify({ root, installationFile, cacheContext }), { flag: 'wx', mode: 0o600 });
  await runOpenCodeProcess(process.execPath, [resolve(root, 'deploy/opencode-child.mjs'), 'prepare', preparation], {
    cwd: root, environment: openCodeEnvironment(environment), signal, timeoutMs: 180_000,
  });
  const installation = JSON.parse(await readFile(installationFile, 'utf8'));
  const loader = await realpath(installation.loader);
  assert(loader.startsWith(resolve(root) + sep), 'Host loader escaped the private installation');
  assert.equal(installation.evidence.package_manager, 'pnpm@11.25.0', 'Private dependency manager differs');
  assert.equal(installation.evidence.lockfile_sha256, source.files['pnpm-lock.yaml'], 'Private dependency lockfile differs');
  await verifyOpenCodeSource(root, source);
  return { loader, evidence: installation.evidence };
}

export async function runOpenCodeChild(manifest, installation, signal, environment = process.env, onMessage) {
  await verifyOpenCodeSource(manifest.root, manifest.source);
  assert.equal(digest(await readFile(manifest.binary.path)), manifest.binary.sha256, 'Private host executable changed');
  const manifestPath = resolve(manifest.directory, 'validation.json');
  await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  const hostGroups = new Set();
  let deadline, forceTimer, cleanupFailed = false;
  const killHost = (pid, name) => {
    try { process.kill(-pid, name); }
    catch (error) { if (error.code !== 'ESRCH') cleanupFailed = true; }
  };
  const stopHosts = () => {
    if (!hostGroups.size) return;
    deadline ??= Date.now() + 1000;
    for (const pid of hostGroups) killHost(pid, 'SIGTERM');
    forceTimer ??= setTimeout(() => {
      for (const pid of hostGroups) killHost(pid, 'SIGKILL');
    }, Math.max(0, deadline - Date.now()));
  };
  signal.addEventListener('abort', stopHosts, { once: true });
  try {
    const result = await runOpenCodeProcess(process.execPath, ['--import', pathToFileURL(installation.loader).href,
      resolve(manifest.root, 'deploy/opencode-child.mjs'), 'execute', manifestPath], {
      cwd: manifest.root, environment: openCodeEnvironment(environment, true), signal, forward: true,
      timeoutMs: 15 * 60_000, killAfterMs: 12_000,
      onMessage: (message, reply, executorPid) => {
        if (message?.event === 'opencode_host_started') {
          const pid = message.pid;
          assert(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== executorPid, 'Invalid host process group');
          // A supervisor is registered before stdin releases its host process.
          // Only a direct child in its own process group can be acknowledged.
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
          assert.equal(Number(fields[1]), executorPid, 'Host supervisor belongs to another parent');
          assert.equal(Number(fields[2]), pid, 'Host supervisor does not own its process group');
          assert(!hostGroups.has(pid), 'Host process group was registered twice');
          hostGroups.add(pid);
          if (signal.aborted) killHost(pid, 'SIGKILL');
          else reply({ event: 'opencode_host_tracked', pid });
        } else if (message?.event === 'opencode_host_closed') {
          assert(hostGroups.has(message.pid), 'Unknown host process group closed');
          killHost(message.pid, 'SIGKILL');
          assert(!cleanupFailed, 'Host process group cleanup failed');
          hostGroups.delete(message.pid);
          reply({ event: 'opencode_host_untracked', pid: message.pid });
        }
        onMessage?.(message);
      },
    });
    assert.equal(hostGroups.size, 0, 'Executor returned with active host process groups');
    return result;
  } finally {
    stopHosts();
    if (deadline) await new Promise(resolveCleanup => setTimeout(resolveCleanup, Math.max(0, deadline - Date.now())));
    for (const pid of hostGroups) killHost(pid, 'SIGKILL');
    if (forceTimer) clearTimeout(forceTimer);
    signal.removeEventListener('abort', stopHosts);
    assert(!cleanupFailed, 'Host process group cleanup failed');
  }
}

export function parseOpenCodeArguments(args) {
  assert.equal(args.length, 7, 'Usage: node deploy/opencode-run.mjs --source-ref SHA --binary PATH --output PATH --live');
  assert.equal(args[6], '--live', 'Explicit --live is required');
  const values = {};
  for (let index = 0; index < 6; index += 2) {
    assert(['--source-ref', '--binary', '--output'].includes(args[index]) && args[index + 1], 'Invalid host validation arguments');
    assert(!Object.hasOwn(values, args[index]), 'Duplicate host validation argument');
    values[args[index]] = args[index + 1];
  }
  assert.match(values['--source-ref'], /^[a-f0-9]{40}$/, 'An exact 40-character source commit is required');
  return { sourceRef: values['--source-ref'], binary: resolve(values['--binary']), output: resolve(values['--output']) };
}

async function main() {
  assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
  assert.equal(process.platform, 'linux', 'Pinned host validation requires Linux');
  assert.equal(process.arch, 'x64', 'Pinned host validation requires x64');
  const args = parseOpenCodeArguments(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cancellation = new AbortController();
  const interrupt = () => { process.exitCode = 1; cancellation.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  process.stdout.on('error', interrupt); process.stderr.on('error', interrupt);
  let directory, reservation, completed = false;
  const discard = () => {
    if (!reservation) return;
    try { const actual = lstatSync(args.output); if (actual.dev === reservation.dev && actual.ino === reservation.ino) rmSync(args.output); }
    catch (error) { if (error.code !== 'ENOENT') process.exitCode = 1; }
  };
  process.on('exit', code => { if (code !== 0 || cancellation.signal.aborted || !completed) discard(); });
  try {
    directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-opencode-'));
    const snapshot = resolve(directory, 'source');
    const source = await archiveOpenCodeSource(root, snapshot, args.sourceRef);
    assert.equal(source.files['deploy/opencode-run.mjs'], digest(launcherBytes), 'Launcher differs from expected source');
    const installation = await prepareOpenCodeDependencies(snapshot, directory, source, cancellation.signal, process.env, root);
    const binary = await copyOpenCodeBinary(args.binary, resolve(directory, 'opencode'), cancellation.signal);
    assert(process.env.NEBIUS_API_KEY, 'Configure NEBIUS_API_KEY without printing it');
    await runOpenCodeChild({ root: snapshot, directory, source, output: args.output, binary, host_dependencies: installation.evidence },
      installation, cancellation.signal, process.env, message => {
        if (message?.event === 'evidence_reserved' && message.path === args.output && Number.isSafeInteger(message.dev) && Number.isSafeInteger(message.ino)) reservation = message;
      });
    completed = true;
  } catch {
    process.exitCode = 1;
    console.error('FAIL: private OpenCode validation preparation or execution failed');
  } finally {
    if (!completed || cancellation.signal.aborted) discard();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch { process.exitCode = 1; console.error('FAIL: invalid OpenCode validation invocation'); }
}
