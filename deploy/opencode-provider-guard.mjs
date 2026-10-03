import { constants, fstatSync, lstatSync, openSync, writeSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Development-only hook for the unmodified, published OpenCode host. Its
// original fetch still calls Nebius directly. No relay or model shim is used.
const BASE = 'https://api.tokenfactory.nebius.com/v1/';
const MODEL = 'nvidia/Nemotron-3_5-Lightning';
const PROVIDER = 'tk-nebius';
const REQUEST_LIMIT = 4;
const MAX_FRAME_BYTES = 65_536;
const MAX_STREAM_BYTES = 2_097_152;
const ACTIVE = Symbol.for('threadkeeper.opencode-provider-guard');
const TOOLS = new Set(['threadkeeper_context_search', 'threadkeeper_context_get_source',
  'threadkeeper_context_capture', 'threadkeeper_context_capture_status']);
const COUNTS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
const OPTIONAL_COUNTS = new Set(['cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
const DETAILS = new Set(['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// numericTokenUsage intentionally exposes only valid counts. This scanner also
// needs sticky invalidity, so it preserves the same nullable-detail contract.
function inspectUsage(value, depth = 0) {
  if (!object(value) || depth > 8) return { invalid: true };
  const usage = {};
  let invalid = false;
  for (const [key, count] of Object.entries(value)) {
    if (COUNTS.has(key)) {
      if (depth > 0 && count === null && OPTIONAL_COUNTS.has(key)) continue;
      if (Number.isSafeInteger(count) && count >= 0) usage[key] = count;
      else invalid = true;
    } else if (DETAILS.has(key)) {
      if (count === null) continue;
      const detail = inspectUsage(count, depth + 1);
      invalid ||= detail.invalid;
      if (detail.usage) usage[key] = detail.usage;
    }
  }
  return { usage: Object.keys(usage).length ? usage : undefined, invalid };
}

function usageComplete(usage) {
  return Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)
    && Number.isSafeInteger(usage?.total_tokens)
    && Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens)
    && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens;
}

function usageConsistent(usage) {
  const prompt = usage.prompt_tokens, completion = usage.completion_tokens;
  const input = usage.input_tokens, output = usage.output_tokens, total = usage.total_tokens;
  if (prompt !== undefined && input !== undefined && prompt !== input) return false;
  if (completion !== undefined && output !== undefined && completion !== output) return false;
  for (const [left, right] of [[prompt, completion], [input, output]]) {
    if (left !== undefined && right !== undefined
      && (!Number.isSafeInteger(left + right) || (total !== undefined && left + right !== total))) return false;
    if (total !== undefined && ((left !== undefined && left > total) || (right !== undefined && right > total))) return false;
  }
  return true;
}

function scanner() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, unreadable = false, done = false, usage, invalid = false;
  let modelSeen = false, modelInvalid = false;
  function frame(text) {
    const data = text.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (done) { unreadable = true; return; }
    if (data === '[DONE]') { done = true; return; }
    let payload;
    try { payload = JSON.parse(data); } catch { unreadable = true; return; }
    if (!object(payload)) { unreadable = true; return; }
    if (Object.hasOwn(payload, 'model')) {
      modelSeen = true;
      modelInvalid ||= payload.model !== MODEL;
    }
    // OpenAI-compatible streams commonly send usage:null before the final
    // usage frame. Unknown optional counts are not zero or a malformed total.
    if (payload.usage !== undefined && payload.usage !== null) {
      const current = inspectUsage(payload.usage);
      invalid ||= current.invalid;
      if (current.usage) {
        if (usage && !isDeepStrictEqual(usage, current.usage)) invalid = true;
        usage ??= current.usage;
        if (!usageConsistent(current.usage)) invalid = true;
      }
    }
  }
  function accept(text) {
    buffer += text;
    // Normalize CRLF after buffering, including CR/LF split across chunks.
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const part = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (Buffer.byteLength(part) > MAX_FRAME_BYTES) { unreadable = true; buffer = ''; return; }
      frame(part);
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { unreadable = true; buffer = ''; }
  }
  return {
    push(chunk) {
      if (unreadable) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_STREAM_BYTES) { unreadable = true; buffer = ''; return; }
      try { accept(decoder.decode(chunk, { stream: true })); }
      catch { unreadable = true; buffer = ''; }
    },
    finish() {
      if (unreadable) return;
      try { accept(decoder.decode()); } catch { unreadable = true; }
      // A complete SSE event must end with its separator, not just EOF.
      if (buffer.trim()) unreadable = true;
      buffer = '';
    },
    evidence() {
      return { done_seen: done, usage_status: unreadable ? 'unreadable' : usage ? 'reported' : 'absent',
        ...(usage ? { usage } : {}), ...(invalid ? { usage_invalid: true } : {}),
        ...(modelSeen ? { returned_model_matches: !modelInvalid } : {}),
        valid: !unreadable && done && modelSeen && !modelInvalid && !invalid && usageComplete(usage) };
    },
  };
}

function createGuard({ apiKey, logPath, originalFetch }) {
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)
    || typeof logPath !== 'string' || !isAbsolute(logPath) || typeof originalFetch !== 'function') {
    throw new Error('opencode_guard_configuration_missing');
  }
  let fd;
  try {
    fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error();
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new Error('opencode_guard_log_not_private');
  }
  let attempts = 0, configInvocations = 0, blocked = false, closed = false;
  const identity = fstatSync(fd);
  function record(value) {
    try {
      if (closed) throw new Error();
      const current = lstatSync(logPath);
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino
        || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new Error();
      const encoded = Buffer.from(JSON.stringify(value) + '\n');
      let offset = 0;
      while (offset < encoded.length) {
        const written = writeSync(fd, encoded, offset);
        if (written <= 0) throw new Error();
        offset += written;
      }
    } catch {
      blocked = true;
      throw new Error('opencode_guard_log_write_failed');
    }
  }
  function fail(code) {
    blocked = true;
    record({ event: 'opencode_guard_failed', code, config_invocations: configInvocations });
    throw new Error(code);
  }
  const guardedFetch = async (input, init) => {
    const ordinal = ++attempts;
    function deny(code) {
      record({ event: 'opencode_provider_denied', ordinal, sent: false, code });
      throw new Error(code);
    }
    if (blocked || closed || configInvocations !== 1) return deny('opencode_guard_not_active');
    if (ordinal > REQUEST_LIMIT) return deny('opencode_guard_request_budget_exhausted');
    const url = input instanceof Request ? input.url : String(input);
    if (url !== BASE + 'chat/completions' || init?.method !== 'POST') return deny('opencode_guard_endpoint_mismatch');
    if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 131_072) return deny('opencode_guard_body_invalid');
    let body;
    try { body = JSON.parse(init.body); } catch { return deny('opencode_guard_body_invalid'); }
    if (!object(body) || body.model !== MODEL || body.reasoning_effort !== 'none'
      || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 1024
      || Object.hasOwn(body, 'max_completion_tokens') || (body.n !== undefined && body.n !== 1)
      || body.stream !== true || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 40
      || Buffer.byteLength(JSON.stringify(body.messages)) > 120_000
      || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > TOOLS.size
        || body.tools.some(tool => !object(tool) || tool.type !== 'function' || !TOOLS.has(tool.function?.name))))) {
      return deny('opencode_guard_provider_contract_mismatch');
    }
    let headers;
    try { headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)); }
    catch { return deny('opencode_guard_authorization_missing'); }
    if (headers.get('authorization') !== `Bearer ${apiKey}`) return deny('opencode_guard_authorization_missing');
    const start = performance.now();
    record({ event: 'opencode_provider_request', ordinal, sent: true, requested_model: MODEL,
      reasoning_effort: 'none', max_tokens: body.max_tokens, stream: true,
      message_count: body.messages.length, tool_names: (body.tools ?? []).map(tool => tool.function.name),
      started_at: new Date().toISOString() });
    let response;
    try { response = await originalFetch(input, { ...init, redirect: 'error' }); }
    catch {
      record({ event: 'opencode_provider_result', ordinal, sent: true, outcome: 'network_error',
        elapsed_ms: Math.round(performance.now() - start), usage_status: 'unreadable', usage_complete: false,
        stream_status: 'read_error', done_seen: false });
      throw new Error('opencode_provider_network_error');
    }
    const scan = scanner();
    let finished = false;
    const isSse = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream';
    function finish(streamStatus) {
      if (finished) return;
      finished = true;
      if (streamStatus === 'complete') scan.finish();
      const { valid, ...evidence } = scan.evidence();
      record({ event: 'opencode_provider_result', ordinal, sent: true, outcome: 'http_response',
        http_status: response.status, elapsed_ms: Math.round(performance.now() - start),
        ...evidence, stream_status: streamStatus,
        usage_complete: response.status === 200 && isSse && streamStatus === 'complete' && valid });
    }
    if (!response.body) { finish('absent'); return response; }
    const reader = response.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            try { finish(isSse ? 'complete' : 'non_sse'); controller.close(); }
            finally { reader.releaseLock(); }
            return;
          }
          if (isSse) scan.push(next.value);
          controller.enqueue(next.value);
        } catch {
          try { finish('read_error'); } finally { controller.error(new Error('opencode_provider_stream_error')); }
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      async cancel() {
        try { finish('cancelled'); }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return {
    config(config) {
      configInvocations++;
      if (configInvocations !== 1 || blocked) return fail('opencode_guard_duplicate_configuration');
      const provider = config.provider?.[PROVIDER];
      if (!Array.isArray(config.enabled_providers) || config.enabled_providers.length !== 1
        || config.enabled_providers[0] !== PROVIDER || Object.keys(config.provider ?? {}).length !== 1
        || !object(provider) || provider.npm !== '@ai-sdk/openai-compatible'
        || !Array.isArray(provider.env) || provider.env.length !== 0 || !object(provider.options)
        || provider.options.baseURL !== BASE || Object.hasOwn(provider.options, 'apiKey')
        || Object.hasOwn(provider.options, 'fetch') || Object.hasOwn(provider, 'apiKey')) {
        return fail('opencode_guard_initial_provider_not_keyless');
      }
      // No usable credential is installed until the guarded fetch exists.
      const options = { ...provider.options, fetch: guardedFetch, apiKey };
      record({ event: 'opencode_guard_ready', provider: PROVIDER, config_invocations: configInvocations,
        request_limit: REQUEST_LIMIT, max_output_tokens: 1024 });
      provider.options = options;
    },
    close() { blocked = true; if (!closed) { closed = true; closeSync(fd); } },
    block() { blocked = true; },
  };
}

// OpenCode invokes every module export as a plugin. Keep exactly one function
// export; its test factory property is not another plugin export. Injection is
// available only to tests, never through environment or production config.
export const OpenCodeProviderGuard = Object.assign(async () => {
  if (globalThis[ACTIVE]) {
    globalThis[ACTIVE].block();
    throw new Error('opencode_guard_already_installed');
  }
  const guard = createGuard({ apiKey: process.env.TK_OPENCODE_API_KEY,
    logPath: process.env.TK_OPENCODE_GUARD_LOG, originalFetch: globalThis.fetch.bind(globalThis) });
  globalThis[ACTIVE] = guard;
  return { config: guard.config };
}, { createForTest: createGuard });
