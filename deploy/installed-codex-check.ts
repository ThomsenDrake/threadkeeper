// Installed Codex host acceptance, using explicit synthetic calls and no model turn.
// Requires an existing codex binary; never installs a client or edits its real home.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createTestDatabase } from '../tests/helpers.ts';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';

const binary = process.env.THREADKEEPER_CODEX_BINARY ?? 'codex';
const outputIndex = process.argv.indexOf('--output');
if (process.argv.slice(2).length && (outputIndex !== 2 || process.argv.length !== 4)) {
  throw new Error('Usage: node --import tsx deploy/installed-codex-check.ts [--output <sanitized-evidence.json>]');
}
const secrets: string[] = [];
const redact = (text: string) => secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text);
const cancellation = new AbortController();
const hosts: CodexHost[] = [];
const commands = new Set<() => Promise<void>>();
const interrupt = () => {
  cancellation.abort();
  for (const stop of commands) void stop();
  for (const host of hosts) host.process.kill('SIGTERM');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

// No inherited provider credentials or user Codex configuration reach the host.
// Preserve managed proxy/CA settings; every configured endpoint is localhost.
function hostEnvironment(home: string, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const name of ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  if (token) env.THREADKEEPER_SYNTHETIC_TOKEN = token;
  return env;
}

async function command(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  if (cancellation.signal.aborted) throw new Error('Host check interrupted');
  return await new Promise<string>((resolveCommand, reject) => {
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    let failure: Error | undefined, force: NodeJS.Timeout | undefined;
    let closed = false, resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const terminate = (reason: Error) => {
      failure ??= reason;
      if (!closed) {
        child.kill('SIGTERM');
        force ??= setTimeout(() => child.kill('SIGKILL'), 5000);
      }
      return exited;
    };
    const stop = () => terminate(new Error('Host check interrupted'));
    commands.add(stop);
    const timeout = setTimeout(() => { void terminate(new Error(`Codex ${args[0]} timed out after 30 seconds`)); }, 30_000);
    child.stdout.on('data', value => { output = redact(output + String(value)).slice(-6000); });
    child.stderr.on('data', value => { errors = redact(errors + String(value)).slice(-6000); });
    child.once('error', error => { void terminate(error); });
    child.once('close', code => {
      closed = true;
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      commands.delete(stop);
      resolveExit();
      // Await the actual close before rejection so finally cannot remove a
      // temporary home while a CLI still uses it, even after interruption.
      if (failure) reject(failure);
      else if (code === 0) resolveCommand(output.trim());
      else reject(new Error(`Codex ${args[0]} failed: ${redact(errors || output).slice(-2000)}`));
    });
    if (cancellation.signal.aborted) void stop();
  });
}

class CodexHost {
  process: ChildProcessWithoutNullStreams;
  threadId = '';
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private errors = '';
  private failure: Error | undefined;
  private closed = false;
  constructor(home: string, token: string, cwd: string) {
    this.process = spawn(binary, ['app-server', '--stdio'], { cwd, env: hostEnvironment(home, token), stdio: 'pipe' });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Codex emitted invalid JSON')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(redact(JSON.stringify(message.error))));
      else pending.resolve(message.result);
    });
    this.process.stderr.on('data', value => { this.errors = redact(this.errors + String(value)).slice(-4000); });
    this.process.stdin.on('error', error => this.fail(error));
    this.process.once('error', error => this.fail(error));
    this.process.once('close', () => { this.closed = true; this.fail(new Error(`Codex host exited: ${this.errors}`)); });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(method: string, params: object): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed || this.process.stdin.destroyed) return Promise.reject(new Error('Codex host has closed'));
    if (cancellation.signal.aborted) return Promise.reject(new Error('Host check interrupted'));
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize(cwd: string) {
    await this.request('initialize', {
      clientInfo: { name: 'threadkeeper-installed-host-check', title: null, version: '1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.process.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const thread = await this.request('thread/start', { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [] });
    this.threadId = thread.thread.id;
    for (let attempt = 0; attempt < 80; attempt++) {
      const inventory = await this.request('mcpServerStatus/list', { threadId: this.threadId });
      const server = inventory.data.find((value: any) => value.name === 'threadkeeper');
      if (server?.runtimeStatus === 'connected') return server;
      if (['failed', 'authenticationRequired', 'cancelled', 'disabled'].includes(server?.runtimeStatus)) {
        throw new Error(redact(`Codex MCP startup failed: ${JSON.stringify(server)}`));
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error('Codex never connected to the disposable Threadkeeper endpoint');
  }
  call(tool: string, arguments_: object = {}) {
    return this.request('mcpServer/tool/call', { threadId: this.threadId, server: 'threadkeeper', tool, arguments: arguments_ });
  }
  async close() {
    if (this.closed || this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>(resolveExit => this.process.once('close', () => resolveExit()));
    this.process.kill('SIGTERM');
    const force = setTimeout(() => this.process.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server?: Server) {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  server.closeAllConnections();
  await closed;
}
function data(result: any) {
  assert.notEqual(result.isError, true, 'Expected a successful installed-host tool call');
  return result.structuredContent ?? JSON.parse(result.content.find((block: any) => block.type === 'text').text);
}
async function denied(action: () => Promise<any>, code: RegExp) {
  try {
    const result = await action();
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), code);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(String(error), code);
  }
}

async function main() {
  const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-codex-host-'));
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let api: Server | undefined, provider: Server | undefined;
  let providerRequests = 0;
  const checks: string[] = [];
  let evidence: any;
  try {
    const version = await command(['--version'], hostEnvironment(directory), directory);
    // Any model/catalog HTTP traffic is a failure, rather than a fixture pass.
    provider = createServer((_request, response) => { providerRequests++; response.writeHead(503).end('No inference is permitted in this host acceptance check.'); });
    const providerOrigin = await listen(provider);
    database = await createTestDatabase(); // Always fresh, in-memory PGlite; no native/operator URL.
    const email = 'installed-host@example.invalid', password = randomBytes(24).toString('hex');
    secrets.push(password);
    await bootstrap(database.db, email, password);
    // Reserve the actual localhost origin before attaching the application's host guard.
    api = createServer();
    const origin = await listen(api);
    api.on('request', createApp(database.db, { origin }).app);
    let cookie = '';
    async function request(path: string, options: { method?: string; body?: unknown } = {}) {
      const response = await fetch(origin + path, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]),
      });
      const result = await response.json() as any;
      assert(response.ok, redact(`Owner HTTP ${path} failed (${response.status}): ${JSON.stringify(result)}`));
      return { data: result, response };
    }
    const login = await request('/api/auth/login', { body: { email, password } });
    cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    secrets.push(cookie);
    const endpoint = (await request('/api/settings/connection')).data.mcp_endpoint;
    assert.equal(endpoint, origin + '/mcp');
    async function host(name: string, permissions: string[]) {
      const credential = (await request('/api/clients', { body: { name, permissions, projects: ['launch'] } })).data;
      secrets.push(credential.token);
      assert.equal(credential.client.last_used_at, null);
      const home = resolve(directory, name), workspace = resolve(home, 'workspace');
      await mkdir(workspace, { recursive: true });
      await writeFile(resolve(home, 'config.toml'), [
        'model_provider = "host_check"', 'model = "host-check-no-inference"',
        '[model_providers.host_check]', 'name = "Synthetic host check; no inference"',
        `base_url = "${providerOrigin}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
        '[analytics]', 'enabled = false', '',
      ].join('\n'), { mode: 0o600 });
      await command(['mcp', 'add', 'threadkeeper', '--url', endpoint, '--bearer-token-env-var', 'THREADKEEPER_SYNTHETIC_TOKEN'], hostEnvironment(home), workspace);
      const client = new CodexHost(home, credential.token, workspace);
      hosts.push(client);
      const inventory = await client.initialize(workspace);
      return { client, credential, tools: Object.keys(inventory.tools).sort() };
    }
    const a = await host('writer', ['read', 'capture']);
    const b = await host('reader', ['read']);
    assert.deepEqual(a.tools, ['context_capture', 'context_capture_status', 'context_get_source', 'context_search']);
    assert.deepEqual(b.tools, ['context_capture_status', 'context_get_source', 'context_search']);
    const used = (await request('/api/clients')).data.clients;
    assert(used.every((client: any) => client.last_used_at));
    checks.push('Two independent installed Codex hosts authenticate with separate scoped credentials and discover their permitted tools.');

    const docs = await readFile(new URL('../docs/CLIENTS.md', import.meta.url), 'utf8');
    const sample = JSON.parse(docs.split('## Synthetic demonstration payload')[1].match(/```json\n([\s\S]*?)\n```/)![1]);
    const receipt = data(await a.client.call('context_capture', sample));
    assert.equal(receipt.status, 'complete');
    const recalled = data(await b.client.call('context_search', { query: '', project_id: 'launch' }));
    assert.equal(recalled.memories.length, 2);
    assert.deepEqual(recalled.memories.map((memory: any) => memory.statement).sort(), sample.explicit_memories.map((memory: any) => memory.statement).sort());
    assert.deepEqual(recalled.memories.map((memory: any) => memory.id).sort(), [...receipt.memory_ids].sort());
    assert(recalled.memories.every((memory: any) => memory.origin === 'user_explicit'));
    for (const memory of recalled.memories) {
      const source = data(await b.client.call('context_get_source', { source_id: memory.evidence[0].source_id }));
      assert.equal(source.text, memory.statement);
    }
    assert.equal(data(await b.client.call('context_capture_status', { capture_id: receipt.capture_id })).status, 'saved');
    checks.push('Client A captures the documented synthetic deadline/preference; Client B recalls current records and their original source evidence/status.');

    const explicit = (id: string, project_id: string | null, statement: string) => ({
      idempotency_key: id, project_id,
      events: [{ id, text: statement, author_role: 'user', origin: 'user_explicit' }],
      explicit_memories: [{ statement, kind: 'fact', source_event_id: id, quote: statement, origin: 'user_explicit' }],
    });
    data(await a.client.call('context_capture', explicit('global-host-check', null, 'Synthetic global host preference.')));
    await request('/api/capture', { body: explicit('private-host-check', 'private', 'Synthetic private project context.') });
    assert.deepEqual(data(await b.client.call('context_search')).memories.map((memory: any) => memory.project_id).sort(), [null, 'launch', 'launch'].sort());
    await denied(() => a.client.call('context_capture', explicit('forbidden-host-check', 'private', 'A denied synthetic project capture.')), /scope_denied/);
    await denied(() => b.client.call('context_search', { project_id: 'private' }), /scope_denied/);
    await denied(() => b.client.call('context_capture', sample), /not found|unknown tool|not available|not enabled/i);
    checks.push('Restricted hosts include global context, exclude private projects, reject forbidden scopes and cannot invoke an unadvertised capture tool.');

    const deadline = recalled.memories.find((memory: any) => memory.kind === 'project_state');
    const preference = recalled.memories.find((memory: any) => memory.kind === 'preference');
    await request(`/api/memories/${deadline.id}`, { method: 'PATCH', body: { statement: 'The launch deadline is October 22, 2026.', expected_revision: deadline.revision } });
    const preview = (await request(`/api/memories/${preference.id}/deletion-preview`)).data;
    await request(`/api/memories/${preference.id}`, { method: 'DELETE', body: { expected_revision: preference.revision, preview_hash: preview.preview_hash } });
    for (const client of [a.client, b.client]) {
      const fresh = data(await client.call('context_search', { query: '', project_id: 'launch' }));
      assert.deepEqual(fresh.memories.map((memory: any) => memory.statement), ['The launch deadline is October 22, 2026.']);
      assert.equal(fresh.memories[0].origin, 'user_explicit');
    }
    checks.push('Owner correction and preview-confirmed forgetting are immediately reflected in fresh recall from both installed hosts.');

    await request('/api/settings/capture', { method: 'PATCH', body: { paused: true, expected_version: 0 } });
    await denied(() => a.client.call('context_capture', sample), /capture_paused/);
    await denied(() => a.client.call('context_capture', explicit('paused-host-check', 'launch', 'A paused synthetic capture.')), /capture_paused/);
    assert.equal(data(await b.client.call('context_search', { query: '', project_id: 'launch' })).memories.length, 1);
    await request('/api/settings/capture', { method: 'PATCH', body: { paused: false, expected_version: 1 } });
    data(await a.client.call('context_capture', explicit('resumed-host-check', 'launch', 'Synthetic capture resumed.')));
    checks.push('Pause rejects new and replayed captures while recall works; resume accepts a new explicit capture.');
    const beforeRevoke = (await request('/api/clients')).data.clients.find((client: any) => client.id === a.credential.client.id).last_used_at;
    await request(`/api/clients/${a.credential.client.id}`, { method: 'DELETE' });
    await denied(() => a.client.call('context_search', {}), /401|unauthorized|authentication/i);
    const revoked = (await request('/api/clients')).data.clients.find((client: any) => client.id === a.credential.client.id);
    assert.equal(revoked.last_used_at, beforeRevoke);
    assert.equal(data(await b.client.call('context_search', { query: 'resumed', project_id: 'launch' })).memories.length, 1);
    checks.push('Revocation denies the writer without changing its last authenticated timestamp; the independent reader retains authorized recall.');
    evidence = {
      recorded_at: new Date().toISOString(), result: 'PASS', host: version, node: process.versions.node,
      database: 'fresh in-memory PGlite', checks,
      invocation: 'Actual Codex app-server mcpServer/tool/call, with explicitly supplied arguments; no model turn submitted.',
      limits: ['Does not establish autonomous model tool selection, installed ChatGPT/Claude integration, learned-provider quality, GPU operation or native database behavior.'],
    };
  } finally {
    // Attempt every cleanup even when another close fails. Keep the model
    // sentinel running until both app-servers have exited.
    const cleanup = await Promise.allSettled([...commands].map(stop => stop()));
    cleanup.push(...await Promise.allSettled(hosts.map(host => host.close())));
    cleanup.push(...await Promise.allSettled([closeServer(api), closeServer(provider)]));
    cleanup.push(...await Promise.allSettled([database?.close(), rm(directory, { recursive: true, force: true })]));
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) throw new Error(redact(`Disposable resource cleanup failed: ${failures.map(result => String(result.reason)).join('; ')}`));
  }
  assert.equal(providerRequests, 0, 'Host acceptance must never call any inference/model endpoint, including host shutdown.');
  evidence.model_endpoint_requests = providerRequests;
  evidence.cleanup = 'Both Codex app-servers, localhost HTTP services, database and temporary homes/credentials removed.';
  const json = JSON.stringify(evidence, null, 2) + '\n';
  assert(redact(json) === json, 'Sanitized evidence must contain no generated credential');
  if (outputIndex !== -1) await writeFile(resolve(process.argv[outputIndex + 1]), json);
  console.info(json);
}

await main().catch(error => { console.error(redact(`FAIL: ${error instanceof Error ? error.message : 'Installed Codex host check failed'}`)); process.exitCode = 1; });
