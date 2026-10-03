import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarios } from './scenarios.ts';

// Always use the managed/local socket, never a saved remote Docker context.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerEnv = { ...process.env };
dockerEnv.DOCKER_BUILDKIT = '1';
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[name];
// The fixture stack cannot accidentally inherit an operator's account/provider.
for (const name of Object.keys(dockerEnv)) {
  if (/^(MODEL_|EMBEDDING_|NEBIUS_|POSTGRES_|BOOTSTRAP_|APP_ORIGIN$|COOKIE_SECURE$|WORKER_POLL_MS$|COMPOSE_|THREADKEEPER_INTEGRATION_)/.test(name)) delete dockerEnv[name];
}
const secrets: string[] = [];
const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
let interrupted = false;
let cleaning = false;
let child: ReturnType<typeof spawn> | undefined;
const cancellation = new AbortController();
const interrupt = () => {
  interrupted = true;
  cancellation.abort(new Error('Integration interrupted'));
  if (!cleaning) child?.kill('SIGTERM');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function docker(args: string[], options: { input?: string; stream?: boolean; cleanup?: boolean } = {}) {
  if (interrupted && !options.cleanup) throw new Error('Integration interrupted');
  return await new Promise<string>((resolveRun, reject) => {
    const running = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], { cwd: root, env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child = running;
    let output = '';
    let errors = '';
    running.stdout.on('data', data => { output += String(data); if (options.stream) process.stdout.write(redact(String(data))); });
    running.stderr.on('data', data => { errors += String(data); if (options.stream) process.stderr.write(redact(String(data))); });
    running.on('error', reject);
    running.on('close', code => {
      if (child === running) child = undefined;
      if (code === 0) resolveRun(output.trim());
      else reject(new Error(redact(`docker ${args[0]} failed (${code ?? 'signal'}): ${(errors || output).slice(-6000)}`)));
    });
    running.stdin.end(options.input);
  });
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Integration requires repository runtime Node.js 24');
  const suffix = randomBytes(6).toString('hex');
  const project = `threadkeeper-integration-${suffix}`;
  const image = `threadkeeper-integration:${suffix}`;
  const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-integration-'));
  const password = randomBytes(32).toString('hex');
  const dbPassword = randomBytes(32).toString('hex');
  secrets.push(password, dbPassword);
  const envFile = resolve(directory, '.env');
  const apiPort = await new Promise<number>((resolvePort, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') { reservation.close(); reject(new Error('Cannot select integration API port')); return; }
      reservation.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
  const composeArgs = ['compose', '--project-name', project, '--env-file', envFile, '-f', 'deploy/compose.yaml', '-f', 'deploy/integration/compose.yaml'];
  const compose = (args: string[], options: Parameters<typeof docker>[1] = {}) => docker([...composeArgs, ...args], options);
  let failure: unknown;
  try {
    await writeFile(envFile, `POSTGRES_PASSWORD=${dbPassword}\nBOOTSTRAP_EMAIL=owner@example.invalid\nBOOTSTRAP_PASSWORD=${password}\nTHREADKEEPER_INTEGRATION_IMAGE=${image}\nTHREADKEEPER_INTEGRATION_PORT=${apiPort}\n`, { mode: 0o600 });
    console.info('Threadkeeper full-container integration: SYNTHETIC HTTP FIXTURE; no learned inference or GPU validation.');
    console.info(`Disposable project: ${project}`);
    const engine = await docker(['info', '--format', '{{.ServerVersion}}']);
    const composeVersion = await docker(['compose', 'version', '--short']);
    console.info(`Host Node ${process.versions.node}; Docker ${engine}; Compose ${composeVersion}`);
    // Optional CA only exists for networked build steps, outside image layers.
    const build = ['build', '--tag', image, '--file', 'deploy/Dockerfile'];
    if (process.env.CODEX_PROXY_CERT) build.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
    build.push('.');
    await docker(build, { stream: true });
    await compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120'], { stream: true });
    const port = async (service: string, containerPort: string) => {
      const address = await compose(['port', service, containerPort]);
      if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`Expected localhost-only ${service} port, got ${address}`);
      return `http://${address}`;
    };
    const baseUrl = await port('api', '3000');
    const controlUrl = await port('fixture', '8080');
    const sql = async (query: string): Promise<any[]> => {
      try {
        const result = await compose(['exec', '-T', 'postgres', 'psql', '-U', 'threadkeeper', '-d', 'threadkeeper', '-v', 'ON_ERROR_STOP=1', '-Atq'], {
          input: `WITH result AS (${query}) SELECT coalesce(json_agg(result.*), '[]'::json) FROM result;\n`,
        });
        return JSON.parse(result);
      } catch (error) {
        throw new Error(`Integration SQL query failed: ${error instanceof Error ? redact(error.message) : 'unknown error'}`);
      }
    };
    const versions = (await sql("SELECT current_setting('server_version') AS postgres, (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector"))[0];
    console.info(`Native PostgreSQL ${versions.postgres}; pgvector ${versions.pgvector}`);
    console.info(`Database image ${await docker(['image', 'inspect', 'pgvector/pgvector:pg17', '--format', '{{join .RepoDigests ","}}'])}`);
    console.info(`Application image ${await docker(['image', 'inspect', image, '--format', '{{.Id}}'])}`);
    console.info(`Application image Node ${await compose(['exec', '-T', 'api', 'node', '--version'])}; pnpm ${await compose(['exec', '-T', 'api', 'pnpm', '--version'])}`);
    const checks = await runScenarios({ baseUrl, controlUrl, email: 'owner@example.invalid', password, sql, signal: cancellation.signal });
    // Rerunnable setup must also work on native state after lifecycle operations.
    await compose(['exec', '-T', 'api', 'pnpm', 'migrate']);
    checks.push('native migrations rerun');
    await compose(['exec', '-T', 'api', 'sh', '-c', 'THREADKEEPER_NATIVE_TEST_URL="$DATABASE_URL" node --import tsx --test tests/hybrid.test.ts tests/api-hybrid.test.ts tests/captures.test.ts tests/review.test.ts']);
    checks.push('native hybrid, capture recovery and candidate review regressions (34 tests)');
    console.info(JSON.stringify({ result: 'PASS', evidence: 'native-full-stack-synthetic-provider', versions, checks }, null, 2));
  } catch (error) {
    failure = error;
    console.error(redact(`FAIL: ${error instanceof Error ? error.message : 'Integration failed'}`));
    // Application logging is deliberately content-free; redact generated secrets
    // as a second guard. Never print resolved Compose configuration or env files.
    try { console.error(redact(await compose(['logs', '--no-color', '--tail', '40'], { cleanup: true }))); } catch { /* original error remains primary */ }
  } finally {
    cleaning = true;
    let cleaned = true;
    try {
      await compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { cleanup: true });
      for (const resource of ['container', 'network', 'volume']) {
        const remaining = await docker([resource, 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`, ...(resource === 'container' ? ['--all'] : [])], { cleanup: true });
        if (remaining) throw new Error(`Disposable ${resource} resources remain for ${project}`);
      }
    } catch (error) {
      cleaned = false;
      failure ??= error;
      console.error(redact(`Cleanup failed for ${project}: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
    try {
      const images = await docker(['image', 'ls', '--quiet', image], { cleanup: true });
      if (images) await docker(['image', 'rm', image], { cleanup: true });
    } catch (error) {
      cleaned = false;
      failure ??= error;
      console.error(redact(`Image cleanup failed for ${project}: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
    try {
      await rm(directory, { recursive: true, force: true });
      if (cleaned) console.info('Cleanup: disposable containers, network, volume, image and credentials removed.');
    } catch (error) {
      failure ??= error;
      console.error(`Credential cleanup failed for ${project}`);
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
  if (failure || interrupted) process.exitCode = 1;
}

await main().catch(error => { console.error(`FAIL: ${redact(error.message)}`); process.exitCode = 1; });
