import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// Development-only observation of the application's original direct fetch.
// No request is relayed. Never retain headers, prompts, response text or errors.
const DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';
const DEFAULT_MODELS = ['nvidia/Nemotron-3_5-Lightning', 'Qwen/Qwen3-Embedding-8B'];
const COUNT_KEYS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
const DETAIL_KEYS = new Set(['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details']);
const hash = value => createHash('sha256').update(value).digest('hex');

export function numericTokenUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, count] of Object.entries(value)) {
    if (COUNT_KEYS.has(key) && Number.isSafeInteger(count) && count >= 0) result[key] = count;
    else if (DETAIL_KEYS.has(key)) {
      const detail = numericTokenUsage(count);
      if (detail && Object.keys(detail).length) result[key] = detail;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function summarizeProviderObservations(records) {
  const usage = {};
  function add(target, source) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (typeof value === 'number') target[key] = (target[key] ?? 0) + value;
      else { target[key] ??= {}; add(target[key], value); }
    }
  }
  const sent = records.filter(record => record.sent);
  const inference = sent.filter(record => record.path !== 'models');
  for (const record of inference) add(usage, record.usage);
  return {
    observed_attempt_count: records.length, direct_request_count: sent.length,
    inference_request_count: inference.length,
    usage_complete: inference.every(record => record.usage_status === 'reported'),
    inference_requests_without_usage: inference.filter(record => record.usage_status !== 'reported').length,
    usage,
  };
}

export function installDirectProviderObserver(options = {}) {
  let bases;
  try { bases = (options.baseUrls ?? [options.baseUrl ?? DEFAULT_BASE_URL]).map(value => new URL(value)); }
  catch { throw new Error('Invalid provider observation base URL'); }
  const endpoints = new Map(bases.flatMap(base => ['models', 'chat/completions', 'embeddings'].map(path => [new URL(path, base).href, path])));
  const models = new Set(options.models ?? DEFAULT_MODELS);
  const originalFetch = globalThis.fetch;
  const records = [];
  const errors = [];
  const counts = {};
  let ordinal = 0;
  function publish(record) {
    records.push(record);
    try { options.onRecord?.(record); }
    catch { errors.push('observation_write_failed'); }
  }
  const observedFetch = async (input, init) => {
    let url;
    try { url = input instanceof Request ? new URL(input.url) : new URL(String(input)); }
    catch { return originalFetch(input, init); }
    const path = endpoints.get(url.href);
    if (!path) return originalFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    // Application adapters submit JSON strings. Do not consume a Request body.
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let request;
    try { request = body === undefined ? undefined : JSON.parse(body); } catch { /* Metadata remains unknown. */ }
    const record = {
      event: 'direct_provider_request', ordinal: ++ordinal, path, method,
      started_at: new Date().toISOString(), sent: false,
      ...(models.has(request?.model) ? { requested_model: request.model } : {}),
      ...(body === undefined ? {} : { request_sha256: hash(body) }),
      ...(Array.isArray(request?.input) ? { input_count: request.input.length } : {}),
    };
    counts[path] = (counts[path] ?? 0) + 1;
    const start = performance.now();
    if (options.limits?.[path] !== undefined && counts[path] > options.limits[path]) {
      publish({ ...record, outcome: 'budget_exhausted', usage_status: 'not_sent', elapsed_ms: 0 });
      throw new Error('provider_observation_request_budget_exhausted');
    }
    let response;
    record.sent = true;
    try { response = await originalFetch(input, init); }
    catch (error) {
      publish({ ...record, outcome: 'network_error', usage_status: 'unreadable', elapsed_ms: Math.round(performance.now() - start) });
      throw error;
    }
    record.http_status = response.status;
    record.outcome = 'http_response';
    try {
      const text = await response.clone().text();
      record.response_sha256 = hash(text);
      let payload;
      try { payload = JSON.parse(text); } catch { /* No raw body is retained. */ }
      if (payload && typeof payload === 'object') {
        if (typeof payload.model === 'string') {
          record.returned_model_matches = payload.model === request?.model;
          if (models.has(payload.model)) record.returned_model = payload.model;
        }
        record.usage = numericTokenUsage(payload.usage);
        const reason = payload.choices?.[0]?.finish_reason;
        if (['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(reason)) record.finish_reason = reason;
      }
      record.usage_status = record.usage ? 'reported' : 'absent';
    } catch { record.usage_status = 'unreadable'; }
    record.elapsed_ms = Math.round(performance.now() - start);
    publish(record);
    return response;
  };
  globalThis.fetch = observedFetch;
  return { records, errors, restore() { if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch; } };
}

// Explicit preload opt-in for disposable native API/worker checks only.
const output = process.env.THREADKEEPER_PROVIDER_OBSERVATIONS_FILE;
if (output) {
  function limit(name) {
    const value = process.env[name];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid provider observation request limit');
    return parsed;
  }
  installDirectProviderObserver({
    baseUrl: process.env.THREADKEEPER_PROVIDER_OBSERVATIONS_BASE_URL ?? DEFAULT_BASE_URL,
    limits: { 'chat/completions': limit('THREADKEEPER_PROVIDER_CHAT_LIMIT'), embeddings: limit('THREADKEEPER_PROVIDER_EMBEDDING_LIMIT') },
    onRecord(record) {
      try {
        const line = JSON.stringify(record) + '\n';
        if (output === '-') process.stdout.write(line);
        else appendFileSync(output, line, { mode: 0o600 });
      } catch {
        process.stderr.write('provider_observation_write_failed\n');
        process.exitCode = 1;
      }
    },
  });
}
