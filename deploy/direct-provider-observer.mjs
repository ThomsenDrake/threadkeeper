import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { embeddingResponseFingerprints } from './embedding-fingerprints.mjs';
import { extractionResponseFingerprint } from './extraction-fingerprints.mjs';

// Development-only observation of the application's original direct fetch.
// No request is relayed. Never retain headers, prompts, response text or errors.
const DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';
const DEFAULT_MODELS = ['nvidia/Nemotron-3_5-Lightning', 'Qwen/Qwen3-Embedding-8B'];
const COUNT_KEYS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
const OPTIONAL_DETAIL_COUNTS = new Set(['cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
const DETAIL_KEYS = new Set(['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details']);
const hash = value => createHash('sha256').update(value).digest('hex');
const ACTIVE_OBSERVER = Symbol.for('threadkeeper.direct-provider-observer');

// Reporting commands consume this configuration explicitly. Importing this
// library never changes fetch or writes files/stdout, even when FILE is set.
export function providerObservationConfigFromEnv(env = process.env) {
  function limit(name) {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid provider observation request limit');
    return parsed;
  }
  const modelBase = env.MODEL_BASE_URL || DEFAULT_BASE_URL;
  return {
    // An explicit observation base adds an alias; it cannot disable observation
    // or request limits for either configured runtime provider endpoint.
    baseUrls: [...new Set([modelBase, env.EMBEDDING_BASE_URL || modelBase, env.THREADKEEPER_PROVIDER_OBSERVATIONS_BASE_URL].filter(Boolean))],
    models: [...new Set([env.MODEL_ID || DEFAULT_MODELS[0], env.EMBEDDING_MODEL, ...DEFAULT_MODELS].filter(Boolean))],
    limits: { 'chat/completions': limit('THREADKEEPER_PROVIDER_CHAT_LIMIT'), embeddings: limit('THREADKEEPER_PROVIDER_EMBEDDING_LIMIT') },
    embeddingFingerprints: env.THREADKEEPER_PROVIDER_EMBEDDING_FINGERPRINTS === '1',
    extractionFingerprints: env.THREADKEEPER_PROVIDER_EXTRACTION_FINGERPRINTS === '1',
  };
}

export function numericTokenUsage(value) {
  return inspectNumericTokenUsage(value).usage;
}

function inspectNumericTokenUsage(value, depth = 0) {
  if (value === undefined) return { usage: undefined, invalid: false };
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return { usage: undefined, invalid: true };
  const result = {};
  let invalid = false;
  for (const [key, count] of Object.entries(value)) {
    if (COUNT_KEYS.has(key)) {
      // Compatible providers use null for unavailable optional breakdowns.
      // Omit that unknown value; never turn it into zero or permit null totals.
      if (depth > 0 && count === null && OPTIONAL_DETAIL_COUNTS.has(key)) continue;
      if (Number.isSafeInteger(count) && count >= 0) result[key] = count;
      else invalid = true;
    }
    else if (DETAIL_KEYS.has(key)) {
      // OpenAI-compatible optional detail objects may be null (unreported).
      // Primary counts remain required numeric values whenever supplied.
      if (count === null) continue;
      const detail = inspectNumericTokenUsage(count, depth + 1);
      invalid ||= detail.invalid;
      if (detail.usage) result[key] = detail.usage;
    }
  }
  return { usage: Object.keys(result).length ? result : undefined, invalid };
}

// Reconcile only known sanitized counts; absence is not zero or completeness.
// Shared by native acceptance and the bounded extraction probes.
export function verifyProviderUsageTotals(item) {
  const usage = item.usage;
  if (!usage) return;
  const count = (name) => {
    const value = usage[name];
    if (value !== undefined) assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'Provider token count must be a nonnegative safe integer');
    return value;
  };
  const total = count('total_tokens');
  const prompt = count('prompt_tokens'), completion = count('completion_tokens');
  const input = count('input_tokens'), output = count('output_tokens');
  if (prompt !== undefined && input !== undefined) assert.equal(prompt, input, 'Provider input token counts contradict each other');
  if (completion !== undefined && output !== undefined) assert.equal(completion, output, 'Provider output token counts contradict each other');
  {
    const before = prompt ?? input, after = completion ?? output;
    if (before !== undefined && after !== undefined) assert(Number.isSafeInteger(before + after), 'Provider token component sum is unsafe');
    if (item.path === 'embeddings') {
      assert(after === undefined || after === 0, 'Embedding usage unexpectedly reports generated completion tokens');
      if (total !== undefined && before !== undefined) assert.equal(total, before, 'Embedding total contradicts input tokens');
    } else if (total !== undefined) {
      if (before !== undefined && after !== undefined) assert.equal(total, before + after, 'Provider total contradicts token components');
      else {
        if (before !== undefined) assert(total >= before, 'Provider total is smaller than input tokens');
        if (after !== undefined) assert(total >= after, 'Provider total is smaller than output tokens');
      }
    }
  }
  // Breakdown categories can overlap, so bound each count independently.
  // A missing parent is unknown; a reported total still supplies an upper bound.
  const detailParents = {
    prompt_tokens_details: prompt ?? input ?? total,
    input_tokens_details: input ?? prompt ?? total,
    completion_tokens_details: completion ?? output ?? total,
    output_tokens_details: output ?? completion ?? total,
  };
  function verifyDetails(details, parent) {
    assert(details && typeof details === 'object' && !Array.isArray(details), 'Provider token details must be an object');
    for (const [key, value] of Object.entries(details)) {
      if (COUNT_KEYS.has(key)) {
        assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'Provider token detail must be a nonnegative safe integer');
        if (parent !== undefined) assert(value <= parent, 'Provider token detail exceeds its parent count');
      } else if (Object.hasOwn(detailParents, key)) verifyDetails(value, parent);
    }
  }
  for (const [key, parent] of Object.entries(detailParents)) {
    if (usage[key] !== undefined) verifyDetails(usage[key], parent);
  }
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
  const complete = record => !record.usage_invalid && record.usage_status === 'reported' && (typeof record.usage?.total_tokens === 'number'
    || (typeof record.usage?.prompt_tokens === 'number' && typeof record.usage?.completion_tokens === 'number')
    || (typeof record.usage?.input_tokens === 'number' && typeof record.usage?.output_tokens === 'number'));
  let derivedTotals = 0;
  for (const record of inference) {
    // Do not turn a rejected raw total into a valid derived component total,
    // nor present any part of a malformed envelope as trustworthy accounting.
    if (record.usage_invalid) continue;
    const reported = record.usage;
    let normalized = reported;
    // Preserve each raw envelope, but do not undercount aggregate totals when
    // a compatible provider reports only a complete input/output pair.
    if (reported && reported.total_tokens === undefined) {
      const total = typeof reported.prompt_tokens === 'number' && typeof reported.completion_tokens === 'number'
        ? reported.prompt_tokens + reported.completion_tokens
        : typeof reported.input_tokens === 'number' && typeof reported.output_tokens === 'number'
          ? reported.input_tokens + reported.output_tokens : undefined;
      if (total !== undefined) { normalized = { ...reported, total_tokens: total }; derivedTotals++; }
    }
    add(usage, normalized);
  }
  return {
    observed_attempt_count: records.length, direct_request_count: sent.length,
    inference_request_count: inference.length,
    usage_complete: inference.every(complete),
    inference_requests_without_usage: inference.filter(record => record.usage_status !== 'reported').length,
    inference_requests_without_complete_usage: inference.filter(record => !complete(record)).length,
    inference_requests_with_invalid_usage: inference.filter(record => record.usage_invalid).length,
    derived_total_tokens_request_count: derivedTotals,
    usage,
  };
}

export function installDirectProviderObserver(options = {}) {
  // A nested observer would mistake a budget rejection by the inner wrapper
  // for an outbound network request. Reject that configuration before any call.
  if (globalThis[ACTIVE_OBSERVER]?.fetch === globalThis.fetch) throw new Error('provider_observer_already_installed');
  let bases;
  try {
    bases = (options.baseUrls ?? [options.baseUrl ?? DEFAULT_BASE_URL]).map(value => {
      const base = new URL(value);
      // Provider bases denote directories even when the configured URL omits
      // its final slash. Preserve /v1 rather than resolving against its parent.
      base.pathname = base.pathname.replace(/\/+$/, '') + '/';
      return base;
    });
  }
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
        if (options.extractionFingerprints && path === 'chat/completions' && response.ok) {
          const fingerprints = extractionResponseFingerprint(request, payload);
          if (fingerprints) record.extraction_fingerprints = fingerprints;
        }
        if (options.embeddingFingerprints && path === 'embeddings' && response.ok) {
          const fingerprints = embeddingResponseFingerprints(request, payload);
          if (fingerprints) record.embedding_fingerprints = fingerprints;
        }
        if (typeof payload.model === 'string') {
          record.returned_model_matches = payload.model === request?.model;
          if (models.has(payload.model)) record.returned_model = payload.model;
        }
        const usage = inspectNumericTokenUsage(payload.usage);
        record.usage = usage.usage;
        if (usage.invalid) record.usage_invalid = true;
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
  globalThis[ACTIVE_OBSERVER] = { fetch: observedFetch };
  return { records, errors, restore() {
    if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
    if (globalThis[ACTIVE_OBSERVER]?.fetch === observedFetch) delete globalThis[ACTIVE_OBSERVER];
  } };
}
