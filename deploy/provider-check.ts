import { evaluateProviderProbe, providerProbeEvent, validateProbeContent } from './provider-probe-rubric.ts';
import { randomUUID } from 'node:crypto';
import { installDirectProviderObserver, providerObservationConfigFromEnv, summarizeProviderObservations } from './direct-provider-observer.mjs';
import {
  createProvider,
  embeddingConfigFromEnv,
  extractionJsonSchema,
  OpenAICompatibleEmbeddingProvider,
  ProviderError,
} from '../packages/providers/src/index.ts';

// Run using operator-configured secrets, not arguments. Only synthetic data is
// sent. This script reports measured checks; it never switches model IDs.
const provider = createProvider();
const checks: Array<Record<string, unknown>> = [];
const embeddingConfig = embeddingConfigFromEnv();
const observer = installDirectProviderObserver({ ...providerObservationConfigFromEnv(), baseUrls: [provider.config.baseUrl, ...(embeddingConfig ? [embeddingConfig.baseUrl] : [])],
  models: [provider.config.modelId, ...(embeddingConfig ? [embeddingConfig.modelId] : [])] });
let extractionObservation: Record<string, unknown> | undefined;

async function check(name: string, run: () => Promise<Record<string, unknown>>) {
  const start = performance.now();
  const attemptStart = observer.records.length;
  try {
    checks.push({ check: name, status: 'passed', ...(await run()), elapsed_ms: Math.round(performance.now() - start) });
  } catch (error) {
    checks.push({
      check: name, status: 'failed',
      reason: error instanceof ProviderError ? error.code : 'check_failed',
      ...(error instanceof ProviderError && error.status ? { http_status: error.status } : {}),
      ...(name === 'source_backed_extraction' && extractionObservation ? { extraction: extractionObservation } : {}),
      elapsed_ms: Math.round(performance.now() - start),
    });
  }
  checks[checks.length - 1].provider_attempts = observer.records.slice(attemptStart);
}

await check('model_available', async () => {
  const models = await provider.listModels();
  if (!models.includes(provider.config.modelId)) throw new ProviderError('configured_model_not_listed');
  return { model: provider.config.modelId, model_count: models.length };
});

await check('chat', async () => {
  const result = await provider.chat({ messages: [{ role: 'user', content: 'Reply with the single word READY.' }], max_tokens: 1200 });
  if (result.choices[0]?.finish_reason === 'length') throw new ProviderError('chat_output_truncated');
  if (!validateProbeContent('chat', result.choices[0]?.message.content, result.choices[0]?.finish_reason, Boolean(result.choices[0]?.message.tool_calls?.length))) throw new ProviderError('chat_unexpected_response');
  return { model: provider.config.modelId, usage: result.usage };
});

await check('no_side_effect_tool_call', async () => {
  const nonce = randomUUID();
  const result = await provider.chat({
    messages: [{ role: 'user', content: `Call record_probe with nonce ${nonce}. It is a validation-only tool and has no side effects.` }],
    tools: [{ type: 'function', function: {
      name: 'record_probe', description: 'Validate a synthetic nonce. No side effects.',
      parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false },
    } }],
    tool_choice: { type: 'function', function: { name: 'record_probe' } },
    max_tokens: 1200,
  });
  const tool = result.choices[0]?.message.tool_calls?.find(call => call.function.name === 'record_probe');
  if (!tool) throw new ProviderError('probe_tool_call_missing');
  let args: unknown;
  try { args = JSON.parse(tool.function.arguments); } catch { throw new ProviderError('probe_tool_arguments_invalid'); }
  if (!args || typeof args !== 'object' || !('nonce' in args) || args.nonce !== nonce) throw new ProviderError('probe_tool_arguments_mismatch');
  return { model: provider.config.modelId, tool_call_validated: true, tool_executed: false, usage: result.usage };
});

await check('json_object', async () => {
  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Return a JSON object exactly like {"ok":true,"deadline":"2026-10-20"}. Do not include commentary.' }],
    response_format: { type: 'json_object' }, max_tokens: 1200,
  });
  if (!validateProbeContent('json_object', result.choices[0]?.message.content, result.choices[0]?.finish_reason, Boolean(result.choices[0]?.message.tool_calls?.length))) throw new ProviderError('json_object_value_invalid');
  return { model: provider.config.modelId, finish_reason: result.choices[0]?.finish_reason, usage: result.usage };
});

// Strict schema is an opt-in capability probe because endpoints/model revisions
// differ. Its result does not gate prompted JSON operation or swap the model.
if (process.env.PROVIDER_CHECK_SCHEMA === 'true') {
  await check('json_schema', async () => {
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Return {"memories":[]} as JSON, without commentary.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'threadkeeper_extraction', strict: true, schema: extractionJsonSchema } },
      max_tokens: 1200,
    });
    if (!validateProbeContent('json_schema', result.choices[0]?.message.content, result.choices[0]?.finish_reason, Boolean(result.choices[0]?.message.tool_calls?.length))) throw new ProviderError('json_schema_output_invalid');
    return { model: provider.config.modelId, usage: result.usage };
  });
} else checks.push({ check: 'json_schema', status: 'skipped', reason: 'optional_probe_not_enabled' });

await check('source_backed_extraction', async () => {
  const result = await provider.extract({ events: [providerProbeEvent], project_id: 'lumen-demo', subject: 'self' });
  const rubric = evaluateProviderProbe(result.memories);
  extractionObservation = { memories: result.memories, usage: result.usage, ...rubric };
  if (!result.memories.length) throw new ProviderError('extraction_missing_expected_memories');
  if (!rubric.expected_deadline) throw new ProviderError('extraction_missing_deadline');
  if (!rubric.expected_preference) throw new ProviderError('extraction_missing_preference');
  if (!rubric.rubric_passed) throw new ProviderError('extraction_unexpected_memories');
  return { model: result.model, memory_count: result.memories.length, validated_evidence: true, usage: result.usage, extraction: extractionObservation };
});

if (embeddingConfig) {
  await check('embeddings', async () => {
    const result = await new OpenAICompatibleEmbeddingProvider(embeddingConfig).embed(['The synthetic deadline is October 20, 2026.', 'The synthetic writing preference is short paragraphs.']);
    return { model: result.model, dimensions: result.dimensions, vector_count: result.vectors.length, usage: result.usage };
  });
} else checks.push({ check: 'embeddings', status: 'skipped', reason: 'EMBEDDING_MODEL_not_configured' });

observer.restore();
console.info(JSON.stringify({ schema_version: 'threadkeeper.provider-check.v1', measured_at: new Date().toISOString(),
  model: provider.config.modelId, transport: 'direct_operator_http_provider', reasoning_effort: provider.config.reasoningEffort ?? null,
  checks, provider_accounting: summarizeProviderObservations(observer.records), observation_errors: observer.errors,
  timing: 'Each attempt measures direct fetch through complete response-body observation; each check also includes validation.',
}, null, 2));
if (observer.errors.length || checks.some(check => check.status === 'failed' && check.check !== 'json_schema')) process.exitCode = 1;
