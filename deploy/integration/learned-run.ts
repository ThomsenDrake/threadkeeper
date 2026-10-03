import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bootstrap only: no operational runner, provider, or acceptance module is
// imported until the committed source snapshot has been created.
export async function archiveLearnedSource(root: string, destination: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const implementation = (path: string) => path && !path.startsWith('docs/') && !path.endsWith('.md');
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

export async function loadLearnedExecutor(snapshotRoot: string, dependencies: string) {
  // This link sits outside the Docker build context. The container installs
  // its own locked dependencies, while host validation resolves this link.
  await symlink(dependencies, resolve(snapshotRoot, '../node_modules'));
  return await import(pathToFileURL(resolve(snapshotRoot, 'deploy/integration/learned-execute.ts')).href);
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
  let directory: string | undefined;
  try {
    directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-learned-'));
    const snapshotRoot = resolve(directory, 'source');
    const source = await archiveLearnedSource(root, snapshotRoot);
    cancellation.signal.throwIfAborted();
    const { runLearnedLifecycle } = await loadLearnedExecutor(snapshotRoot, resolve(root, 'node_modules'));
    cancellation.signal.throwIfAborted();
    await runLearnedLifecycle({ root: snapshotRoot, directory, source, output, cancellation });
  } catch {
    process.exitCode = 1;
    console.error('FAIL: native acceptance source preparation or execution failed');
  } finally {
    // The archived executor cleans all resources before PASS. This fallback
    // also covers import/bootstrap failures before it could install cleanup.
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
