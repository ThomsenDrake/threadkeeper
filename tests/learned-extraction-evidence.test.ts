import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { installDirectProviderObserver, summarizeProviderObservations } from '../deploy/direct-provider-observer.mjs';
import { extractionRecordsFingerprint, extractionResponseFingerprint } from '../deploy/extraction-fingerprints.mjs';
import { snapshotLearnedExtraction, verifyLearnedExtractionEvidence } from '../deploy/integration/learned-extraction-evidence.ts';
import { verifyLearnedObservations, type LearnedObservation } from '../deploy/integration/learned-support.ts';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { OpenAICompatibleProvider, providerConfigFromEnv } from '../packages/providers/src/index.ts';
import { createTestDatabase } from './helpers.ts';

const baseUrl = 'http://127.0.0.1:18818/v1/';
const model = 'nvidia/Nemotron-3_5-Lightning';
const response = (memories: unknown[]) => ({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ memories }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
const event = { id: 'synthetic-extraction-source', text: 'The synthetic deadline is October 20, 2026.', author_role: 'user', origin: 'user_explicit' };
const candidate = { statement: event.text, quote: event.text, source_event_id: event.id, kind: 'fact', origin: 'user_explicit' };
const context = { project_id: 'synthetic-extraction-evidence', subject: 'self', events: [event] };
const request = { model, messages: [{ role: 'user', content: JSON.stringify(context) }] };

test('invalid recognized raw token counts remain invalid through actual original-fetch observation and native validation', async () => {
  const originalFetch = globalThis.fetch;
  const malformed: unknown[] = [
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: -1 },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 'private-invalid-count' },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14.5 },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, completion_tokens_details: { reasoning_tokens: -1 } },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: 'private-invalid-details' },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 0.5 } },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, completion_tokens_details: { audio_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, completion_tokens_details: { accepted_prediction_tokens: 'private-invalid-breakdown' } },
    ...['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens'].map(key => ({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, [key]: null })),
    null, 'private-invalid-envelope',
  ];
  let raw: unknown;
  globalThis.fetch = async () => new Response(JSON.stringify({ ...response([candidate]), usage: raw }));
  const observer = installDirectProviderObserver({ baseUrl });
  try {
    for (const usage of malformed) {
      raw = usage;
      const received = await fetch(baseUrl + 'chat/completions', { method: 'POST', body: JSON.stringify(request) });
      assert.deepEqual((await received.json() as any).usage, usage, 'Observer must preserve original provider data');
      const recorded = observer.records.at(-1)!;
      assert.equal(recorded.usage_invalid, true);
      assert.equal(recorded.extraction_fingerprints, undefined, 'Generic observation must not enable extraction fingerprints');
      assert.throws(() => verifyLearnedObservations([{ ...recorded, service: 'worker' }]), /usage|token/i);
    }
    const summary = summarizeProviderObservations(observer.records);
    assert.equal(summary.usage_complete, false);
    assert.equal(summary.inference_requests_with_invalid_usage, malformed.length);
    assert.equal(summary.derived_total_tokens_request_count, 0);
    assert.deepEqual(summary.usage, {}, 'Malformed raw totals cannot become valid sanitized component totals');
    assert(!JSON.stringify(observer.records).includes('private-invalid'));
    raw = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: null, completion_tokens_details: null,
      future_private_field: 'opaque-unknown-field' };
    await fetch(baseUrl + 'chat/completions', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(observer.records.at(-1)!.usage_invalid, undefined);
    assert.equal(summarizeProviderObservations([observer.records.at(-1)!]).usage_complete, true);
    assert(!JSON.stringify(observer.records).includes('opaque-unknown-field'));
    // Exact observed Nebius shape, with optional unknowns kept distinct from 0.
    raw = { completion_tokens: 3, prompt_tokens: 21, total_tokens: 24,
      completion_tokens_details: { accepted_prediction_tokens: null, audio_tokens: null, reasoning_tokens: 0, rejected_prediction_tokens: null },
      prompt_tokens_details: null, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 21 };
    await fetch(baseUrl + 'chat/completions', { method: 'POST', body: JSON.stringify(request) });
    const compatible = observer.records.at(-1)!;
    assert.equal(compatible.usage_invalid, undefined);
    assert.deepEqual(compatible.usage, { completion_tokens: 3, prompt_tokens: 21, total_tokens: 24, completion_tokens_details: { reasoning_tokens: 0 } });
    const compatibleSummary = summarizeProviderObservations([compatible]);
    assert.equal(compatibleSummary.usage_complete, true);
    assert.equal(compatibleSummary.inference_requests_with_invalid_usage, 0);
    assert.equal(compatibleSummary.usage.total_tokens, 24);
    raw = { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24,
      prompt_tokens_details: { cached_tokens: null, audio_tokens: null }, completion_tokens_details: { reasoning_tokens: null } };
    await fetch(baseUrl + 'chat/completions', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(observer.records.at(-1)!.usage_invalid, undefined);
    assert.deepEqual(observer.records.at(-1)!.usage, { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24 });
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});

test('extraction fingerprints retain multiplicity and reject malformed or refused raw choices without retaining text', () => {
  const observed = extractionResponseFingerprint(request, response([candidate]))!;
  assert.equal(observed.memory_count, 1);
  assert.notEqual(extractionResponseFingerprint(request, response([candidate, candidate]))!.memories_sha256, observed.memories_sha256);
  const withNulls = { ...candidate, subject: null, effective_at: null };
  assert.deepEqual(extractionResponseFingerprint(request, response([withNulls])), observed);
  for (const choice of [
    { finish_reason: {}, message: { content: JSON.stringify({ memories: [candidate] }) } },
    { finish_reason: 'stop', message: { content: JSON.stringify({ memories: [candidate] }), tool_calls: {} } },
    { finish_reason: 'stop', message: { content: JSON.stringify({ memories: [candidate] }), refusal: 0 } },
    { finish_reason: 'length', message: { content: JSON.stringify({ memories: [candidate] }) } },
    { finish_reason: 'stop', message: { content: JSON.stringify({ memories: [candidate] }), refusal: 'private-refusal-text' } },
    { finish_reason: 'stop', message: { content: '{"memories":[]}', tool_calls: [{ id: 'x', type: 'function', function: { name: 'x', arguments: '{}' } }] } },
  ]) assert.equal(extractionResponseFingerprint(request, { model, choices: [choice] }), undefined);
  for (const bad of [
    { ...candidate, unsupported: 'extra' }, { ...candidate, source_event_id: 'unknown' },
    { ...candidate, quote: 'A missing quote' }, { ...candidate, subject: 'someone-else' },
    { ...candidate, effective_at: '2028-01-01T00:00:00Z' }, { ...candidate, statement: 'x'.repeat(4001) },
  ]) assert.equal(extractionResponseFingerprint(request, response([bad])), undefined);
  assert.equal(extractionResponseFingerprint(request, response(Array(65).fill(candidate))), undefined);
  assert.equal(extractionResponseFingerprint(request, { ...response([candidate]), model: 'different-model' }), undefined);
  assert(!JSON.stringify(observed).includes(event.text));
});

test('actual extraction/storage binds origin normalization, subject defaults and timestamp serialization to the final response', async t => {
  const database = await createTestDatabase(); t.after(() => database.close());
  const originalFetch = globalThis.fetch;
  const sources = [
    { id: 'explicit', text: ' Starting at 2027-02-03T08:30:00+01:00, I prefer morning meetings. ', author_role: 'user', origin: 'user_explicit' },
    { id: 'confirmed', text: 'I confirmed the original plan.', author_role: 'user', origin: 'user_confirmed' },
    { id: 'reported', text: 'The agent reported completed checks.', author_role: 'assistant', origin: 'agent_reported' },
    { id: 'proposed', text: 'The assistant proposed moving the demo.', author_role: 'assistant', origin: 'assistant_proposed' },
    { id: 'inferred', text: 'The synthetic launch may require a checklist.', author_role: 'assistant', origin: 'inferred' },
  ];
  const memories = sources.map((source, index) => ({ statement: index === 0 ? ' I prefer morning meetings. ' : source.text,
    kind: index === 0 ? 'preference' : 'fact', source_event_id: source.id, quote: source.text,
    origin: index === 0 ? 'user_confirmed' : source.origin === 'inferred' ? 'agent_reported' : 'user_explicit',
    ...(index === 0 ? { subject: null, effective_at: '2027-02-03T08:30:00+01:00' } : {}),
  })).reverse();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(calls === 1
      ? { ...response([]), choices: [{ finish_reason: 'stop', message: { content: 'unusable-first-attempt' } }] }
      : response(memories)));
  };
  const observer = installDirectProviderObserver({ baseUrl, extractionFingerprints: true });
  try {
    const provider = new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl, apiKey: 'synthetic-secret' });
    const store = createStore(database.db);
    const owner: Auth = { ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null };
    const receipt = await store.capture(owner, { idempotency_key: randomUUID(), project_id: context.project_id, subject: 'self', events: sources });
    assert.equal((await store.processJob(provider))?.status, 'complete');
    const persisted = (await store.list(owner, { project_id: context.project_id })).memories;
    const retainedSources = await Promise.all(receipt.source_ids.map((id: string) => store.getSource(owner, id)));
    const snapshot = snapshotLearnedExtraction(persisted, retainedSources, context);
    const records: LearnedObservation[] = observer.records.map(record => ({ ...record, service: 'worker' }));
    assert.equal(records.length, 2);
    assert.equal(records[0].extraction_fingerprints, undefined);
    assert.deepEqual(verifyLearnedExtractionEvidence(snapshot, records), { ordinal: 2, memory_count: 5 });
    assert.equal(persisted.find(memory => memory.statement.startsWith(' I prefer'))!.effective_at, '2027-02-03T07:30:00.000Z');
    assert(persisted.some(memory => memory.origin === 'agent_reported') && persisted.some(memory => memory.origin === 'assistant_proposed'));
    const inference = persisted.find(memory => memory.statement === sources[4].text)!;
    assert.equal(inference.origin, 'inferred');
    assert.equal(inference.status, 'candidate');
    const wrongFinal = structuredClone(records);
    wrongFinal[0].extraction_fingerprints = snapshot;
    wrongFinal[1].extraction_fingerprints!.memories_sha256 = '0'.repeat(64);
    assert.throws(() => verifyLearnedExtractionEvidence(snapshot, wrongFinal), /final direct provider response/);
    const changedStored = structuredClone(persisted); changedStored[0].statement += ' changed';
    assert.throws(() => verifyLearnedExtractionEvidence(snapshotLearnedExtraction(changedStored, retainedSources, context), records));
    const changedInput = structuredClone(retainedSources); changedInput[0].client_id = 'different-client';
    assert.throws(() => verifyLearnedExtractionEvidence(snapshotLearnedExtraction(persisted, changedInput, context), records));
    const serialized = JSON.stringify({ snapshot, records });
    for (const hidden of ['synthetic-secret', 'unusable-first-attempt', ...sources.map(source => source.text), ...memories.map(memory => memory.statement)]) assert(!serialized.includes(hidden));
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});

test('inferred response fingerprints agree with the actual adapter and reject promoted canonical records', async () => {
  const originalFetch = globalThis.fetch;
  const source = { ...event, author_role: 'assistant' as const, origin: 'inferred' as const };
  const input = { ...context, events: [source] };
  const raw = response([{ ...candidate, origin: 'agent_reported' }]);
  let capturedRequest: unknown;
  globalThis.fetch = async (_url, init) => {
    capturedRequest = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(raw));
  };
  try {
    const result = await new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl }).extract(input);
    assert.equal(result.memories[0].origin, 'inferred');
    const canonical = result.memories.map(memory => ({ ...memory, project_id: input.project_id, subject: input.subject,
      status: 'candidate', effective_at: null }));
    const observed = extractionResponseFingerprint(capturedRequest, raw);
    assert(observed);
    assert.deepEqual(observed, extractionRecordsFingerprint(canonical, input));
    const promoted = canonical.map(memory => ({ ...memory, origin: 'agent_reported', status: 'active' }));
    assert.notDeepEqual(observed, extractionRecordsFingerprint(promoted, input));
  } finally { globalThis.fetch = originalFetch; }
});

test('discarding the observed extraction and fabricating correct persisted rows fails response binding', async t => {
  const database = await createTestDatabase(); t.after(() => database.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(response([{ ...candidate, statement: 'The synthetic deadline is October 19, 2026.' }])));
  const observer = installDirectProviderObserver({ baseUrl, extractionFingerprints: true });
  try {
    const realAdapter = new OpenAICompatibleProvider({ ...providerConfigFromEnv({}), baseUrl });
    const store = createStore(database.db);
    const owner: Auth = { ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null };
    const receipt = await store.capture(owner, { idempotency_key: randomUUID(), ...context });
    await store.processJob({ async extract(input) {
      await realAdapter.extract(input); // Regression: pay for then discard the real response.
      return { model, memories: [{ ...candidate, kind: 'fact', origin: 'user_explicit' }] };
    } });
    const persisted = (await store.list(owner, { project_id: context.project_id })).memories;
    assert.deepEqual(persisted.map(memory => memory.statement), [event.text]);
    const sources = await Promise.all(receipt.source_ids.map((id: string) => store.getSource(owner, id)));
    const snapshot = snapshotLearnedExtraction(persisted, sources, context);
    assert.throws(() => verifyLearnedExtractionEvidence(snapshot, observer.records.map(record => ({ ...record, service: 'worker' }))), /differs from the final/);
    assert.equal(observer.records.length, 1, 'Binding adds no inference');
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});
