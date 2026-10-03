import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLearnedScenarios } from './learned-scenarios.ts';
import { summarizeProviderObservations, type ProviderObservation } from '../direct-provider-observer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
assert(process.env.NEBIUS_API_KEY, 'Configure NEBIUS_API_KEY without printing it');
const output = process.argv[2];
assert(process.argv.length <= 3, 'Usage: pnpm integration:learned [evidence.json]');
// Immutable identity is mandatory before billed requests. Documentation/artifact
// edits are allowed, but every tracked implementation/configuration byte is hashed.
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const implementationFiles = git('ls-files', '-z').split('\0').filter(path => path && !path.startsWith('docs/') && !path.endsWith('.md'));
assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...implementationFiles), '', 'Commit source changes before live validation');
assert.deepEqual(git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(path => path && !path.startsWith('docs/') && !path.endsWith('.md')), [], 'Commit new implementation files before live validation');
const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  files: Object.fromEntries(await Promise.all(implementationFiles.map(async path => [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')]))),
};
const dockerEnv: NodeJS.ProcessEnv = { ...process.env, DOCKER_BUILDKIT: '1' };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[name];
for (const name of Object.keys(dockerEnv)) if (/^(MODEL_|EMBEDDING_|POSTGRES_|BOOTSTRAP_|APP_ORIGIN$|COOKIE_SECURE$|WORKER_POLL_MS$|COMPOSE_|THREADKEEPER_)/.test(name)) delete dockerEnv[name];
const secrets = [process.env.NEBIUS_API_KEY];
const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
const cancellation = new AbortController();
let cleaning = false;
let stopCommand: (() => void) | undefined;
let createdOutput: string | undefined;
const interrupt = () => { process.exitCode = 1; cancellation.abort(); if (!cleaning) stopCommand?.(); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
process.stdout.on('error', interrupt);
process.on('exit', code => {
  if (createdOutput && (code !== 0 || cancellation.signal.aborted)) {
    try { rmSync(createdOutput); } catch { process.exitCode = 1; }
  }
});
async function docker(args: string[], options: { input?: string; cleanup?: boolean; timeout?: number } = {}) {
  if (!options.cleanup) cancellation.signal.throwIfAborted();
  return await new Promise<string>((resolveRun, reject) => {
    const running = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], { cwd: root, env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    let force: NodeJS.Timeout | undefined;
    const stop = () => { running.kill('SIGTERM'); force ??= setTimeout(() => running.kill('SIGKILL'), 5000); };
    stopCommand = stop;
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout ?? 120_000);
    running.stdout.on('data', data => { stdout += String(data); });
    running.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
    running.once('error', error => { clearTimeout(timer); if (force) clearTimeout(force); reject(error); });
    running.once('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force);
      if (stopCommand === stop) stopCommand = undefined;
      if (code === 0 && !timedOut) resolveRun(stdout.trim());
      else reject(new Error(redact(`docker ${args[0]} ${timedOut ? 'timed out' : `failed (${code ?? 'signal'})`}: ${stderr || stdout.slice(-6000)}`)));
    });
    running.stdin.end(options.input);
  });
}

const suffix = randomBytes(6).toString('hex');
const project = `threadkeeper-learned-${suffix}`;
const image = `threadkeeper-learned:${suffix}`;
const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-learned-'));
const envFile = resolve(directory, '.env');
const password = randomBytes(32).toString('hex'), dbPassword = randomBytes(32).toString('hex');
secrets.push(password, dbPassword);
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); assert(address && typeof address === 'object'); server.close(error => error ? reject(error) : resolvePort(address.port)); });
});
const composeArgs = ['compose', '--project-name', project, '--env-file', envFile, '-f', 'deploy/compose.yaml', '-f', 'deploy/integration/learned-compose.yaml'];
const compose = (args: string[], options: Parameters<typeof docker>[1] = {}) => docker([...composeArgs, ...args], options);
let failure: unknown;
let result: Record<string, unknown> | undefined;
let observations: ProviderObservation[] = [];
let cleanupPassed = false;
try {
  const ca = process.env.CODEX_PROXY_CERT ?? '/etc/ssl/certs/ca-certificates.crt';
  await writeFile(envFile, `POSTGRES_PASSWORD=${dbPassword}\nBOOTSTRAP_EMAIL=owner@example.invalid\nBOOTSTRAP_PASSWORD=${password}\nTHREADKEEPER_LEARNED_IMAGE=${image}\nTHREADKEEPER_LEARNED_PORT=${port}\nTHREADKEEPER_LEARNED_CA=${ca}\n`, { mode: 0o600 });
  console.info(`Direct learned native lifecycle: ${project}; exact Nemotron + Qwen 256; synthetic context only.`);
  const engine = await docker(['info', '--format', '{{.ServerVersion}}']);
  const composeVersion = await docker(['compose', 'version', '--short']);
  const build = ['build', '--tag', image, '--file', 'deploy/Dockerfile'];
  if (process.env.CODEX_PROXY_CERT) build.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
  console.info('Building disposable application image.');
  await docker([...build, '.'], { timeout: 600_000 });
  console.info('Starting isolated PostgreSQL, API and learned-provider worker.');
  await compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120'], { timeout: 150_000 });
  const sql = async (query: string): Promise<any[]> => JSON.parse(await compose(['exec', '-T', 'postgres', 'psql', '-U', 'threadkeeper', '-d', 'threadkeeper', '-v', 'ON_ERROR_STOP=1', '-Atq'], {
    input: `WITH result AS (${query}) SELECT coalesce(json_agg(result.*), '[]'::json) FROM result;\n`,
  }));
  const versions = (await sql("SELECT current_setting('server_version') AS postgres, (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector"))[0];
  const appImage = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  const dbImage = await docker(['image', 'inspect', 'pgvector/pgvector:pg17', '--format', '{{join .RepoDigests ","}}']);
  const runtimeNode = await compose(['exec', '-T', 'api', 'node', '--version']);
  const runtimePnpm = await compose(['exec', '-T', 'api', 'pnpm', '--version']);
  assert.match(runtimeNode, /^v24\./); assert.equal(runtimePnpm, '11.25.0');
  const timeout = setTimeout(interrupt, 600_000);
  try {
    const flow = await runLearnedScenarios({ baseUrl: `http://127.0.0.1:${port}`, email: 'owner@example.invalid', password, sql, signal: cancellation.signal });
    result = { schema_version: 'threadkeeper.direct-learned-lifecycle.v1', measured_at: new Date().toISOString(), source,
      transport: 'application_api_and_worker_direct_nebius_https_no_relay', synthetic_only: true,
      configuration: { model: 'nvidia/Nemotron-3_5-Lightning', base_url: 'https://api.tokenfactory.nebius.com/v1/', reasoning_effort: 'none', embedding_model: 'Qwen/Qwen3-Embedding-8B', embedding_dimensions: 256 },
      runtime: { host_node: process.versions.node, node: runtimeNode, pnpm: runtimePnpm, docker: engine, compose: composeVersion, ...versions, application_image: appImage, database_image: dbImage },
      ...flow,
    };
  } finally { clearTimeout(timeout); }
} catch (error) {
  failure = error;
  // An SDK error may contain request headers. Never print arbitrary transport
  // errors; static assertions and Docker diagnostics are redacted separately.
  console.error(error instanceof assert.AssertionError || (error instanceof Error && /^(docker |Timed out:)/.test(error.message))
    ? `FAIL: ${redact(error.message)}` : 'FAIL: direct learned lifecycle or disposable runtime failed');
} finally {
  cleaning = true;
  try {
    await compose(['stop', '--timeout', '10', 'api', 'worker'], { cleanup: true });
    const logs = await compose(['logs', '--no-color', '--no-log-prefix', 'api', 'worker'], { cleanup: true });
    observations = logs.split('\n').flatMap(line => {
      try { const parsed = JSON.parse(line); return parsed.event === 'direct_provider_request' ? [parsed] : []; } catch { return []; }
    });
  } catch (error) { failure ??= error; }
  try {
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { cleanup: true });
    for (const resource of ['container', 'network', 'volume']) assert.equal(await docker([resource, 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`, ...(resource === 'container' ? ['--all'] : [])], { cleanup: true }), '', `Disposable ${resource} remains`);
    if (await docker(['image', 'ls', '--quiet', image], { cleanup: true })) await docker(['image', 'rm', image], { cleanup: true });
    await rm(directory, { recursive: true, force: true });
    cleanupPassed = true;
    console.info('Cleanup: disposable containers, network, volume, image and generated credentials removed.');
  } catch (error) { failure ??= error; console.error(`Cleanup failed for ${project}`); }
}
// Failed attempts remain measurable, including provider output rejected by the
// application. A failed acceptance run is never serialized with a PASS label.
if (result && !failure && !cancellation.signal.aborted) {
  try {
    assert(observations.length > 0, 'Provider request observations missing');
    assert(observations.every(item => item.sent && item.http_status === 200), 'A provider request failed or exceeded its budget');
    const chat = observations.filter(item => item.path === 'chat/completions');
    const embeddings = observations.filter(item => item.path === 'embeddings');
    assert(chat.length >= 1 && chat.length <= 2, 'Unexpected extraction request count');
    assert(embeddings.length >= 2 && embeddings.length <= 12, 'Unexpected embedding request count');
    result.provider_requests = observations;
    result.provider_usage = summarizeProviderObservations(observations);
    assert((result.provider_usage as { usage_complete: boolean }).usage_complete, 'Provider usage accounting incomplete');
    result.provider_request_count = observations.length;
    result.cleanup = cleanupPassed;
    result.result = 'PASS';
    result.limits = ['Synthetic SDK clients are not installed autonomous hosts.', 'One fixed lifecycle is not a broad model quality or sustained-load estimate.', 'Hosted native-container acceptance does not establish local GPU parity, deployment, publication or provider-retained deletion.'];
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (output) {
      cancellation.signal.throwIfAborted();
      const file = await open(resolve(output), 'wx', 0o600);
      createdOutput = resolve(output);
      try { await file.writeFile(serialized); } finally { await file.close(); }
      cancellation.signal.throwIfAborted();
    }
    console.info(JSON.stringify({ result: 'PASS', provider_request_count: observations.length, checks: result.checks, output: output ?? null }));
  } catch (error) { failure = error; console.error('FAIL: provider observations or evidence publication incomplete'); }
}
if (failure || cancellation.signal.aborted) {
  console.error(JSON.stringify({ result: 'FAIL', provider_requests: observations, cleanup: cleanupPassed }));
  process.exitCode = 1;
}
