import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { runLearnedScenarios } from './learned-scenarios.ts';
import { verifyLearnedVectorEvidence } from './learned-vector-evidence.ts';
import { verifyLearnedExtractionEvidence } from './learned-extraction-evidence.ts';
import { inspectLearnedContainerImage, parseLearnedObservations, reserveEvidence, settleLearnedCleanup, verifyLearnedApplicationImages, verifyLearnedObservations, verifyLearnedSnapshot, type LearnedObservation } from './learned-support.ts';

export async function runLearnedLifecycle(options: {
  root: string; directory: string; output: string; cancellation: AbortController;
  source: { commit: string; tree: string; files: Record<string, string> };
  host_dependencies?: Record<string, string>;
}) {
const { root, directory, source, output, cancellation } = options;
assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
assert(process.env.NEBIUS_API_KEY, 'Configure NEBIUS_API_KEY without printing it');
assert(output, 'Evidence destination required');
const dockerEnv: NodeJS.ProcessEnv = { ...process.env, DOCKER_BUILDKIT: '1' };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[name];
for (const name of Object.keys(dockerEnv)) if (/^(MODEL_|EMBEDDING_|POSTGRES_|BOOTSTRAP_|APP_ORIGIN$|COOKIE_SECURE$|WORKER_POLL_MS$|COMPOSE_|THREADKEEPER_)/.test(name)) delete dockerEnv[name];
const secrets = [process.env.NEBIUS_API_KEY];
const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
let stopCommand: (() => void) | undefined;
let cancelledCleanupDeadline: number | undefined;
let evidence: Awaited<ReturnType<typeof reserveEvidence>> | undefined;
const interrupt = () => {
  process.exitCode = 1;
  cancelledCleanupDeadline ??= Date.now() + 8000;
  cancellation.abort(); stopCommand?.();
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
process.stdout.on('error', interrupt);
process.stderr.on('error', interrupt);
process.on('exit', code => {
  if (code !== 0 || cancellation.signal.aborted) {
    try { evidence?.discardSync(); } catch { process.exitCode = 1; }
  }
});
async function docker(args: string[], options: { input?: string; cleanup?: boolean; timeout?: number } = {}) {
  if (!options.cleanup) cancellation.signal.throwIfAborted();
  if (options.cleanup && cancellation.signal.aborted) {
    cancelledCleanupDeadline ??= Date.now() + 8000;
    if (Date.now() >= cancelledCleanupDeadline) throw new Error('Cancelled Docker cleanup budget exhausted');
  }
  return await new Promise<string>((resolveRun, reject) => {
    const running = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], { cwd: root, env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    let inputFailed = false;
    let force: NodeJS.Timeout | undefined;
    const stop = () => {
      running.kill('SIGTERM');
      const grace = cancellation.signal.aborted ? Math.max(0, Math.min(250, (cancelledCleanupDeadline ?? Date.now()) - Date.now())) : 5000;
      force ??= setTimeout(() => running.kill('SIGKILL'), grace);
    };
    stopCommand = stop;
    const remaining = options.cleanup && cancellation.signal.aborted ? Math.min(2000, cancelledCleanupDeadline! - Date.now()) : options.timeout ?? 120_000;
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, remaining));
    running.stdout.on('data', data => { stdout += String(data); });
    running.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
    running.stdin.on('error', () => { inputFailed = true; stop(); });
    running.once('error', error => { clearTimeout(timer); if (force) clearTimeout(force); reject(error); });
    running.once('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force);
      if (stopCommand === stop) stopCommand = undefined;
      if (code === 0 && !timedOut && !inputFailed) resolveRun(stdout.trim());
      else reject(new Error(redact(`docker ${args[0]} ${timedOut ? 'timed out' : `failed (${code ?? 'signal'})`}: ${stderr || stdout.slice(-6000)}`)));
    });
    running.stdin.end(options.input);
  });
}

const suffix = randomBytes(6).toString('hex');
const project = `threadkeeper-learned-${suffix}`;
const image = `threadkeeper-learned:${suffix}`;
let composeArgs: string[] | undefined;
const compose = (args: string[], options: Parameters<typeof docker>[1] = {}) => {
  assert(composeArgs, 'Disposable Compose context is not ready');
  return docker([...composeArgs, ...args], options);
};
let failure: unknown;
let result: Record<string, unknown> | undefined;
let observations: LearnedObservation[] = [];
let cleanupPassed = false;
try {
  cancellation.signal.throwIfAborted();
  await verifyLearnedSnapshot(root, source);
  evidence = await reserveEvidence(output);
  if (process.send) await new Promise<void>((resolveSend, reject) => process.send!({ event: 'evidence_reserved', ...evidence!.identity }, (error: Error | null) => error ? reject(error) : resolveSend()));
  const envFile = resolve(directory, '.env');
  const password = randomBytes(32).toString('hex'), dbPassword = randomBytes(32).toString('hex');
  secrets.push(password, dbPassword);
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); assert(address && typeof address === 'object'); server.close(error => error ? reject(error) : resolvePort(address.port)); });
  });
  const ca = process.env.CODEX_PROXY_CERT ?? '/etc/ssl/certs/ca-certificates.crt';
  await writeFile(envFile, `POSTGRES_PASSWORD=${dbPassword}\nBOOTSTRAP_EMAIL=owner@example.invalid\nBOOTSTRAP_PASSWORD=${password}\nTHREADKEEPER_LEARNED_IMAGE=${image}\nTHREADKEEPER_LEARNED_PORT=${port}\nTHREADKEEPER_LEARNED_CA=${ca}\n`, { mode: 0o600 });
  composeArgs = ['compose', '--project-name', project, '--env-file', envFile, '-f', resolve(root, 'deploy/compose.yaml'), '-f', resolve(root, 'deploy/integration/learned-compose.yaml')];
  console.info(`Direct learned native lifecycle: ${project}; exact Nemotron + Qwen 256; synthetic context only.`);
  const engine = await docker(['info', '--format', '{{.ServerVersion}}']);
  const composeVersion = await docker(['compose', 'version', '--short']);
  const imageIdentityFile = resolve(directory, 'application.iid');
  const build = ['build', '--tag', image, '--iidfile', imageIdentityFile, '--file', 'deploy/Dockerfile'];
  if (process.env.CODEX_PROXY_CERT) build.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
  console.info('Building disposable application image.');
  await docker([...build, '.'], { timeout: 600_000 });
  const builtImage = (await readFile(imageIdentityFile, 'utf8')).trim();
  assert.match(builtImage, /^sha256:[0-9a-f]{64}$/, 'Build omitted its immutable image identity');
  console.info('Starting isolated PostgreSQL, API and learned-provider worker.');
  await compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120'], { timeout: 150_000 });
  const sql = async (query: string): Promise<any[]> => JSON.parse(await compose(['exec', '-T', 'postgres', 'psql', '-U', 'threadkeeper', '-d', 'threadkeeper', '-v', 'ON_ERROR_STOP=1', '-Atq'], {
    input: `WITH result AS (${query}) SELECT coalesce(json_agg(result.*), '[]'::json) FROM result;\n`,
  }));
  const versions = (await sql("SELECT current_setting('server_version') AS postgres, (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector"))[0];
  const appImage = await inspectLearnedContainerImage('api', compose, docker);
  const workerImage = await inspectLearnedContainerImage('worker', compose, docker);
  verifyLearnedApplicationImages(builtImage, appImage.image, workerImage.image);
  const dbImage = await inspectLearnedContainerImage('postgres', compose, docker);
  const runtimeNode = await compose(['exec', '-T', 'api', 'node', '--version']);
  const runtimePnpm = await compose(['exec', '-T', 'api', 'pnpm', '--version']);
  assert.match(runtimeNode, /^v24\./); assert.equal(runtimePnpm, '11.25.0');
  const timeout = setTimeout(interrupt, 600_000);
  try {
    const flow = await runLearnedScenarios({ baseUrl: `http://127.0.0.1:${port}`, email: 'owner@example.invalid', password, sql, signal: cancellation.signal });
    result = { schema_version: 'threadkeeper.direct-learned-lifecycle.v1', measured_at: new Date().toISOString(), source,
      transport: 'application_api_and_worker_direct_nebius_https_no_relay', synthetic_only: true,
      configuration: { model: 'nvidia/Nemotron-3_5-Lightning', base_url: 'https://api.tokenfactory.nebius.com/v1/', reasoning_effort: 'none', embedding_model: 'Qwen/Qwen3-Embedding-8B', embedding_dimensions: 256 },
      runtime: { host_node: process.versions.node, host_dependencies: options.host_dependencies, node: runtimeNode, pnpm: runtimePnpm, docker: engine, compose: composeVersion, ...versions,
        application_build_image: builtImage, application_image: appImage.image, application_repository_digests: appImage.repository_digests,
        database_image: dbImage.image, database_repository_digests: dbImage.repository_digests },
      ...flow,
    };
    await verifyLearnedSnapshot(root, source);
  } finally { clearTimeout(timeout); }
} catch (error) {
  failure = error;
  // An SDK error may contain request headers. Never print arbitrary transport
  // errors; static assertions and Docker diagnostics are redacted separately.
  console.error(error instanceof assert.AssertionError || (error instanceof Error && /^(docker |Timed out:)/.test(error.message))
    ? `FAIL: ${redact(error.message)}` : 'FAIL: direct learned lifecycle or disposable runtime failed');
} finally {
  const steps: Array<() => Promise<unknown>> = [];
  if (composeArgs) {
    steps.push(() => compose(['stop', '--timeout', '10', 'api', 'worker'], { cleanup: true }));
    for (const service of ['api', 'worker'] as const) steps.push(async () => {
      const logs = await compose(['logs', '--no-color', '--no-log-prefix', service], { cleanup: true });
      observations.push(...parseLearnedObservations(logs, service));
    });
    steps.push(() => compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { cleanup: true }));
    for (const resource of ['container', 'network', 'volume']) steps.push(async () => {
      assert.equal(await docker([resource, 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`, ...(resource === 'container' ? ['--all'] : [])], { cleanup: true }), '', `Disposable ${resource} remains`);
    });
    steps.push(async () => {
      if (await docker(['image', 'ls', '--quiet', image], { cleanup: true })) await docker(['image', 'rm', image], { cleanup: true });
    });
  }
  // This independent last step also runs when Docker is inaccessible or stop,
  // logs, down, resource assertions or image removal fail.
  steps.push(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  const cleanupFailures = await settleLearnedCleanup(steps);
  cleanupPassed = cleanupFailures.length === 0;
  failure ??= cleanupFailures[0];
  if (cleanupPassed) console.info('Cleanup: disposable containers, network, volume, image and generated credentials removed.');
  else console.error(`Cleanup failed for ${project}; independent local credential removal was attempted.`);
}
// Failed attempts remain measurable, including provider output rejected by the
// application. A failed acceptance run is never serialized with a PASS label.
if (result && !failure && !cancellation.signal.aborted) {
  try {
    result.provider_requests = observations;
    result.provider_usage = verifyLearnedObservations(observations);
    result.vector_observation_binding = verifyLearnedVectorEvidence(result.vector_evidence, observations);
    result.extraction_observation_binding = verifyLearnedExtractionEvidence(result.extraction_evidence, observations);
    result.provider_request_count = observations.length;
    result.cleanup = cleanupPassed;
    result.result = 'PASS';
    result.limits = ['Synthetic SDK clients are not installed autonomous hosts.', 'One fixed lifecycle is not a broad model quality or sustained-load estimate.', 'Hosted native-container acceptance does not establish local GPU parity, deployment, publication or provider-retained deletion.'];
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (evidence) await evidence.publish(serialized, cancellation.signal);
    console.info(JSON.stringify({ result: 'PASS', provider_request_count: observations.length, checks: result.checks, output: output ?? null }));
  } catch (error) { failure = error; console.error('FAIL: provider observations or evidence publication incomplete'); }
}
if (failure || cancellation.signal.aborted) {
  console.error(JSON.stringify({ result: 'FAIL', provider_requests: observations, cleanup: cleanupPassed }));
  process.exitCode = 1;
}

if (evidence) {
  try { if (failure || cancellation.signal.aborted) await evidence.discard(); }
  finally { await evidence.close(); }
}
}
