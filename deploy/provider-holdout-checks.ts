import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemorySchema } from '../packages/contracts/src/index.ts';
import { DEFAULT_MODEL_ID } from '../packages/providers/src/index.ts';
import type { EvaluationCase } from './provider-evaluation-corpus.ts';
import { evaluateMemoryRubric, type EvaluationMemory } from './provider-evaluation-rubric.ts';
import { summarizeProviderObservations, type ProviderObservation, type ProviderObserverOptions } from './direct-provider-observer.mjs';

export const holdoutRequestLimits: NonNullable<ProviderObserverOptions['limits']> = { 'chat/completions': 16, embeddings: 0, models: 0 };

export function evaluateHoldoutOutcome(item: EvaluationCase, memories: EvaluationMemory[], job: { status: string; accepted: number }) {
  const rubric = evaluateMemoryRubric(item, memories);
  return { ...rubric, rubric_passed: job.status === 'complete' && job.accepted === memories.length && rubric.rubric_passed };
}

export function assessHoldoutObservations(cases: Array<{ provider_attempts?: ProviderObservation[] }>, records: ProviderObservation[], expectedCases = 8) {
  const issues: string[] = [];
  const perCase = cases.map(item => item.provider_attempts ?? []);
  if (cases.length !== expectedCases || perCase.some(attempts => attempts.length < 1 || attempts.length > 2)) issues.push('case_attempt_count');
  if (JSON.stringify(perCase.flat()) !== JSON.stringify(records)) issues.push('unassigned_provider_attempt');
  if (records.some((record, index) => record.ordinal !== index + 1)) issues.push('attempt_order');
  if (records.length > expectedCases * 2 || records.some(record => !record.sent || record.path !== 'chat/completions' || record.method !== 'POST')) issues.push('request_budget_or_type');
  if (records.some(record => record.requested_model !== DEFAULT_MODEL_ID || (record.http_status !== undefined && record.http_status >= 200 && record.http_status < 300
    && (record.returned_model !== DEFAULT_MODEL_ID || record.returned_model_matches !== true)))) issues.push('unverified_model_identity');
  const accounting = summarizeProviderObservations(records);
  if (!accounting.usage_complete) issues.push('incomplete_token_accounting');
  return { status: issues.length ? 'incomplete' : 'complete', issues };
}

// Compare source provenance independently of the three transports agreeing
// with each other. All inputs here belong to the disposable synthetic capture.
export function assertHoldoutRecords(item: EvaluationCase, memories: any[], sources: any[], context: { project: string; client_id: string }): void {
  assert.equal(sources.length, item.events.length);
  assert.equal(new Set(sources.map(source => source.id)).size, sources.length);
  assert.equal(new Set(sources.map(source => source.event_id)).size, sources.length);
  const byId = new Map(sources.map(source => [source.id, source]));
  for (const source of sources) {
    const event = item.events.find(event => event.id === source.event_id);
    assert(event);
    assert.equal(source.text, event.text);
    assert.equal(source.author_role, event.author_role);
    assert.equal(source.origin, event.origin);
    assert.equal(source.client_id, context.client_id);
    assert.equal(source.project_id, context.project);
    assert.equal(source.subject, 'self');
    assert.equal(source.capture_method, event.origin === 'agent_reported' ? 'client_summary' : 'explicit_capture');
    assert.equal(source.extraction_blocked, false);
    assert.equal(source.checksum, createHash('sha256').update(event.text).digest('hex'));
    if (event.occurred_at === undefined) assert.equal(source.occurred_at, null);
    else assert.equal(new Date(source.occurred_at).toISOString(), new Date(event.occurred_at).toISOString());
    assert(Number.isFinite(Date.parse(source.recorded_at)));
  }
  assert.equal(new Set(memories.map(memory => memory.id)).size, memories.length);
  for (const raw of memories) {
    const memory = MemorySchema.parse(raw);
    assert.equal(memory.project_id, context.project);
    assert.equal(memory.subject, 'self');
    assert.equal(memory.revision, 1);
    assert.equal(memory.authoritative, false);
    assert.equal(memory.extractor, DEFAULT_MODEL_ID);
    assert.equal(memory.created_at, memory.updated_at);
    assert(Array.isArray(raw.evidence));
    assert.equal(raw.evidence.length, 1);
    const evidence = raw.evidence[0];
    const source = byId.get(evidence.source_id);
    assert(source);
    assert.equal(evidence.client_id, source.client_id);
    assert.equal(evidence.author_role, source.author_role);
    assert.equal(evidence.origin, source.origin);
    assert.equal(evidence.capture_method, source.capture_method);
    for (const field of ['occurred_at', 'recorded_at']) {
      if (source[field] === null) assert.equal(evidence[field], null);
      else assert.equal(Date.parse(evidence[field]), new Date(source[field]).valueOf());
    }
    assert.equal(typeof evidence.quote, 'string');
    assert(evidence.quote.length > 0 && source.text.includes(evidence.quote));
  }
}
