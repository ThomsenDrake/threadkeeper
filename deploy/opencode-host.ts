import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { phaseTool, type HostPhase } from './opencode-evidence.ts';

export const opencodeModel = 'nvidia/Nemotron-3_5-Lightning';
export const opencodeEndpoint = 'https://api.tokenfactory.nebius.com/v1/';
export type HostResult = { phase: HostPhase; code: number | null; signal: NodeJS.Signals | null; timed_out: boolean;
  closed: boolean; group_terminated: boolean;
  output_valid: boolean; session_ids: string[]; completed: boolean; error_event: boolean;
  tool_events: Array<{ name: string; status: string }>; provider: any[] };

export function opencodeEnvironment(directory: string, key: string, log: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LANG', 'LC_ALL']) if (process.env[name]) env[name] = process.env[name];
  return Object.assign(env, {
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    XDG_CONFIG_HOME: resolve(directory, 'xdg-config'), XDG_DATA_HOME: resolve(directory, 'data'),
    XDG_CACHE_HOME: resolve(directory, 'cache'), XDG_STATE_HOME: resolve(directory, 'state'),
    TMPDIR: resolve(directory, 'tmp'), OPENCODE_TEST_HOME: resolve(directory, 'home'), OPENCODE_CONFIG_DIR: resolve(directory, 'config'),
    npm_config_cache: resolve(directory, 'npm-cache'), npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', npm_config_prefix: resolve(directory, 'npm-prefix'),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1',
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: '0', OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '1024',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    TK_OPENCODE_API_KEY: key, TK_OPENCODE_GUARD_LOG: log,
  });
}

export async function runOpenCodeHost(options: { root: string; directory: string; binary: string; key: string;
  phase: HostPhase; endpoint: string; token: string; prompt: string; signal: AbortSignal }): Promise<HostResult> {
  options.signal.throwIfAborted();
  const directory = resolve(options.directory, options.phase), tool = `threadkeeper_${phaseTool(options.phase)}`;
  for (const sub of ['work', 'config/plugins', 'data', 'cache', 'state', 'tmp', 'home', 'xdg-config']) await mkdir(resolve(directory, sub), { recursive: true, mode: 0o700 });
  const log = resolve(directory, 'provider.jsonl');
  await writeFile(log, '', { flag: 'wx', mode: 0o600 });
  // Official auto-discovery accepts .js/.ts. Preserve the frozen plain-JS
  // guard bytes under the same .js loading mechanism tested by the sentinel.
  const guardSource = resolve(options.root, 'deploy/opencode-provider-guard.mjs'), guard = resolve(directory, 'config/plugins/guard.js');
  await copyFile(guardSource, guard);
  assert.deepEqual(await readFile(guard), await readFile(guardSource), 'Private provider guard copy differs');
  const config = {
    model: `tk-nebius/${opencodeModel}`, small_model: `tk-nebius/${opencodeModel}`, enabled_providers: ['tk-nebius'],
    provider: { 'tk-nebius': { npm: '@ai-sdk/openai-compatible', env: [], options: { baseURL: opencodeEndpoint, timeout: 30000, headerTimeout: 30000, chunkTimeout: 30000 },
      models: { [opencodeModel]: { tool_call: true, limit: { context: 32768, output: 1024 }, options: { reasoningEffort: 'none' } } } } },
    mcp: { threadkeeper: { type: 'remote', url: options.endpoint, oauth: false, headers: { Authorization: `Bearer ${options.token}` } } },
    default_agent: 'threadkeeper-check', subagent_depth: 0, autoupdate: false, share: 'disabled', snapshot: false, compaction: { auto: false, prune: false },
    agent: { title: { disable: true }, 'threadkeeper-check': { mode: 'primary', description: 'Bounded synthetic Threadkeeper lifecycle', steps: 3,
      prompt: 'You are validating user-authorized synthetic Threadkeeper context. Use the configured MCP tool when asked to save or recall context. Preserve source text and provenance exactly. Do not invent memory content. After the tool succeeds, answer briefly.',
      permission: { '*': 'deny', [tool]: 'allow' } } },
  };
  await writeFile(resolve(directory, 'config/opencode.json'), JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  const env = opencodeEnvironment(directory, options.key, log);
  assert(!env.NEBIUS_API_KEY && !env.OPENAI_API_KEY && !env.NODE_OPTIONS && !env.NODE_PATH);
  let stdout = '', outputBytes = 0, timedOut = false, exceeded = false, groupTerminationFailed = false;
  options.signal.throwIfAborted();
  const child = spawn(process.execPath, [resolve(options.root, 'deploy/opencode-host-child.mjs'), options.binary,
    'run', '--format', 'json', '--agent', 'threadkeeper-check', '--title', `Threadkeeper ${options.phase}`, options.prompt],
    { cwd: resolve(directory, 'work'), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let force: NodeJS.Timeout | undefined;
  const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') groupTerminationFailed = true; } } };
  const stop = () => {
    killGroup('SIGTERM');
    force ??= setTimeout(() => { killGroup('SIGKILL'); }, 5000);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 120_000);
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  child.stdout.on('data', value => {
    outputBytes += value.length;
    if (outputBytes > 1_000_000) { exceeded = true; stop(); return; }
    stdout += value;
  });
  // Host stderr may include provider error bodies. Bound it without retaining or publishing it.
  child.stderr.on('data', value => { outputBytes += value.length; if (outputBytes > 1_000_000) { exceeded = true; stop(); } });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.once('error', () => { exceeded = true; });
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  child.stdin.on('error', () => { exceeded = true; stop(); });
  try {
    if (process.send) await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => finish(new Error('Host process registration timed out')), 5000);
      const abort = () => finish(new Error('Host registration interrupted'));
      const message = (value: any) => { if (value?.event === 'opencode_host_tracked' && value.pid === child.pid) finish(); };
      const finish = (error?: Error) => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); process.removeListener('message', message); error ? reject(error) : done(); };
      process.on('message', message); options.signal.addEventListener('abort', abort, { once: true });
      process.send!({ event: 'opencode_host_started', pid: child.pid }, (error: Error | null) => { if (error) finish(error); });
      if (options.signal.aborted) abort();
    });
    options.signal.throwIfAborted(); child.stdin.end('start\n');
  } catch { exceeded = true; stop(); }
  const outcome = await closed;
  // A descendant can close its stdio before its leader. Terminate the whole
  // registered group even on successful leader exit, before clearing grace.
  killGroup('SIGKILL');
  clearTimeout(timer); if (force) clearTimeout(force); options.signal.removeEventListener('abort', stop);
  if (!groupTerminationFailed && process.send) {
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => finish(new Error('Host cleanup acknowledgement timed out')), 5000);
        const message = (value: any) => { if (value?.event === 'opencode_host_untracked' && value.pid === child.pid) finish(); };
        const finish = (error?: Error) => { clearTimeout(timer); process.removeListener('message', message); error ? reject(error) : done(); };
        process.on('message', message);
        process.send!({ event: 'opencode_host_closed', pid: child.pid }, (error: Error | null) => { if (error) finish(error); });
      });
    } catch { exceeded = true; }
  }
  let events: any[] = [], outputValid = !exceeded;
  try { events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { outputValid = false; }
  const provider: any[] = [];
  try {
    const text = await readFile(log, 'utf8');
    if (text.length > 1_000_000 || (text && !text.endsWith('\n'))) outputValid = false;
    for (const line of text.slice(0, 1_000_000).split('\n').filter(Boolean)) {
      try { provider.push(JSON.parse(line)); } catch { outputValid = false; }
    }
  } catch { outputValid = false; }
  return { phase: options.phase, ...outcome, timed_out: timedOut, output_valid: outputValid,
    closed: true, group_terminated: !groupTerminationFailed,
    session_ids: [...new Set(events.map(event => event.sessionID).filter((id): id is string => typeof id === 'string'))],
    completed: events.some(event => event.type === 'step_finish' && event.part?.reason === 'stop'),
    error_event: events.some(event => event.type === 'error'),
    tool_events: events.filter(event => event.type === 'tool_use').map(event => ({ name: event.part?.tool, status: event.part?.state?.status })), provider };
}

export function assertHostResult(result: HostResult) {
  assert(result.closed && result.group_terminated, 'Host process group was not closed');
  assert.equal(result.code, 0, 'OpenCode host did not exit successfully');
  assert(!result.timed_out && result.output_valid && result.completed && !result.error_event, 'OpenCode host did not complete a successful model turn');
  assert.equal(result.session_ids.length, 1, 'Expected one fresh OpenCode session');
  assert(result.tool_events.length >= 1 && result.tool_events.every(event => event.name === `threadkeeper_${phaseTool(result.phase)}` && event.status === 'completed'), 'Host tool events differ from the allowed phase');
  const ready = result.provider.filter(item => item.event === 'opencode_guard_ready');
  assert.equal(ready.length, 1, 'Expected one request guard per host');
  assert.equal(ready[0].config_invocations, 1, 'Provider guard was reconfigured');
  const requests = result.provider.filter(item => item.event === 'opencode_provider_request');
  const responses = result.provider.filter(item => item.event === 'opencode_provider_result');
  assert(requests.length >= 1 && requests.length <= 4, 'Host model request bound differs');
  assert.equal(requests.length, responses.length, 'Host omitted request completion evidence');
  assert(!result.provider.some(item => item.event === 'opencode_provider_denied' || item.event === 'opencode_guard_failed'), 'Host reached a forbidden request');
  assert.deepEqual(requests.map(request => request.ordinal), requests.map((_, index) => index + 1), 'Request ordinals differ');
  for (const request of requests) {
    assert.equal(request.requested_model, opencodeModel); assert.equal(request.reasoning_effort, 'none');
    assert.equal(request.stream, true); assert(Number.isSafeInteger(request.max_tokens) && request.max_tokens >= 1 && request.max_tokens <= 1024);
    assert.deepEqual(request.tool_names, [`threadkeeper_${phaseTool(result.phase)}`], 'Actual provider tools differ from configured phase');
    const matches = responses.filter(response => response.ordinal === request.ordinal);
    assert.equal(matches.length, 1, 'Missing or duplicate provider result');
    assert.equal(matches[0].http_status, 200); assert.equal(matches[0].outcome, 'http_response');
    assert(matches[0].usage_complete === true && matches[0].returned_model_matches === true, 'Host provider usage/result incomplete');
  }
}
