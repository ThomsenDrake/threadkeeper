import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { taxonomyProbe, taxonomyProbeManifest, taxonomyProbeSha256 } from '../deploy/provider-taxonomy-probe.ts';
import { evaluateTaxonomyOutcome } from '../deploy/provider-taxonomy-checks.ts';
import { assertHoldoutRecords, assessHoldoutObservations } from '../deploy/provider-holdout-checks.ts';
import type { EvaluationMemory } from '../deploy/provider-evaluation-rubric.ts';
import { installDirectProviderObserver } from '../deploy/direct-provider-observer.mjs';
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_BASE_URL } from '../packages/providers/src/index.ts';

const statements = ['The user rides the tram to the user\'s studio on Tuesdays.',
  'The user prefers taking the tram to the user\'s studio over driving.',
  'I cannot enter my studio before 11:30.', 'My bicycle has a cargo rack.',
  'The deployment agent reports that the Elm migration is in the validation phase.', '', 'I keep a toolbox in the hallway.'];
function memories(index: number): EvaluationMemory[] {
  return taxonomyProbe[index].expected.map(expected => ({ statement: statements[index], kind: expected.kind ?? expected.accepted_kinds![0],
    origin: expected.origin, status: 'active', effective_at: null,
    evidence: [{ event_id: expected.source_event_id, quote: taxonomyProbe[index].events[0].text }] }));
}
const outcome = (index: number, values = memories(index), status = 'complete') => evaluateTaxonomyOutcome(taxonomyProbe[index], values, { status, accepted: values.length });

test('predeclared taxonomy probe accepts faithful slots, union report and completed empty only', () => {
  assert.equal(taxonomyProbeSha256, '9c7a600b1883bce8359af7ac0f9471d0ef14fb7d66a98b9c3e5b00fbd5398077');
  assert.equal(taxonomyProbe.length, 7);
  for (const [index] of taxonomyProbe.entries()) {
    assert(outcome(index).rubric_passed);
    assert.deepEqual(outcome(index).assessment_dimensions, { content: 'passed', provenance: 'passed', taxonomy: 'passed' });
    assert(!outcome(index, memories(index), 'failed').rubric_passed);
    assert.deepEqual(outcome(index, memories(index), 'failed').assessment_dimensions, { content: 'not_measured', provenance: 'not_measured', taxonomy: 'not_measured' });
  }
  const report = memories(4); report[0].kind = 'project_state'; assert(outcome(4, report).rubric_passed);
});

test('taxonomy-only mismatches do not become factual or attribution failures', () => {
  for (const index of [0, 1, 2, 3, 4, 6]) {
    const values = memories(index); values[0].kind = 'decision';
    assert(!outcome(index, values).rubric_passed);
    assert.deepEqual(outcome(index, values).assessment_dimensions, { content: 'passed', provenance: 'passed', taxonomy: 'failed' });
  }
  const values = memories(4); values[0].origin = 'user_confirmed';
  assert.deepEqual(outcome(4, values).assessment_dimensions, { content: 'passed', provenance: 'failed', taxonomy: 'passed' });
});

test('complete assertions reject inferred habits, exclusive days, access guarantees, question copying and demonstration facts', () => {
  for (const [index, statement] of [
    [0, 'I ride the tram to my studio only on Tuesdays.'],
    [0, 'I prefer riding the tram to my studio on Tuesdays.'],
    [1, 'I take the tram to my studio.'],
    [2, 'I can enter my studio at 11:30.'],
    [3, 'My bicycle has a cargo rack and can carry the samples.'],
    [3, 'Since my bicycle has a cargo rack, could it carry the samples?'],
    [4, 'The deployment agent reports that the Elm migration is complete.'],
    [6, 'I prefer tart apples.'],
  ] as const) {
    const values = memories(index); values[0].statement = statement;
    const result = outcome(index, values); assert(!result.rubric_passed, statement);
    assert.equal(result.assessment_dimensions.content, 'failed');
    assert.equal(result.assessment_dimensions.taxonomy, 'passed');
  }
  for (const index of [5, 6]) {
    const values = memories(index); values.push({ statement: 'I prefer tart apples.', kind: 'preference', origin: 'user_explicit', status: 'active', effective_at: null,
      evidence: [{ event_id: taxonomyProbe[index].events[0].id, quote: 'I prefer tart apples.' }] });
    const result = outcome(index, values);
    assert(!result.rubric_passed); assert.equal(result.assessment_dimensions.content, 'failed');
    assert.equal(result.assessment_dimensions.taxonomy, 'not_measured', 'Do not arbitrarily assign an extra record to a expected slot');
  }
  const wrongQuote = memories(0); wrongQuote[0].evidence[0].quote = 'Invented tram Tuesdays studio';
  assert.equal(outcome(0, wrongQuote).assessment_dimensions.provenance, 'failed');
});

test('unknown source time and quoted agent capture provenance remain independent requirements', () => {
  const item = taxonomyProbe[4], event = item.events[0];
  const source = { id: 'source', event_id: event.id, client_id: 'writer', project_id: 'project', subject: 'self', text: event.text,
    author_role: 'assistant', origin: 'agent_reported', occurred_at: null, recorded_at: '2026-10-03T12:01:00Z',
    checksum: createHash('sha256').update(event.text).digest('hex'), extraction_blocked: false, capture_method: 'client_summary' };
  const memory = { ...memories(4)[0], id: 'memory', project_id: 'project', subject: 'self', revision: 1, authoritative: false,
    extractor: DEFAULT_MODEL_ID, created_at: '2026-10-03T12:01:02Z', updated_at: '2026-10-03T12:01:02Z',
    evidence: [{ source_id: source.id, quote: event.text, client_id: source.client_id, author_role: source.author_role, origin: source.origin,
      capture_method: source.capture_method, occurred_at: source.occurred_at, recorded_at: source.recorded_at }] };
  const check = (value: any, original: any) => assertHoldoutRecords(item, [value], [original], { project: 'project', client_id: 'writer' });
  check(memory, source);
  for (const change of [{ occurred_at: source.recorded_at }, { capture_method: 'explicit_capture' }, { author_role: 'user' }, { origin: 'user_explicit' }]) {
    const changed = structuredClone(memory); Object.assign(changed.evidence[0], change);
    assert.throws(() => check(changed, { ...source, ...change }), 'Consistent corruption must not pass transport agreement');
  }
  const changed = structuredClone(memory); (changed.evidence[0] as any).occurred_at = source.recorded_at;
  assert.throws(() => check(changed, source));
});

test('taxonomy observation budget permits fourteen chats, forbids embeddings, and assesses seven cases', async () => {
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async () => { sent++; return Response.json({ model: DEFAULT_MODEL_ID, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); };
  const observer = installDirectProviderObserver({ baseUrl: DEFAULT_MODEL_BASE_URL, limits: { 'chat/completions': taxonomyProbeManifest.budget.max_chat_requests, embeddings: 0, models: 0 } });
  try {
    for (let i = 0; i < 14; i++) await fetch(DEFAULT_MODEL_BASE_URL + 'chat/completions', { method: 'POST', body: JSON.stringify({ model: DEFAULT_MODEL_ID }) });
    const cases = Array.from({ length: 7 }, (_, index) => ({ provider_attempts: observer.records.slice(index * 2, index * 2 + 2) }));
    assert.equal(assessHoldoutObservations(cases, observer.records, 7).status, 'complete');
    await assert.rejects(fetch(DEFAULT_MODEL_BASE_URL + 'chat/completions', { method: 'POST' }));
    await assert.rejects(fetch(DEFAULT_MODEL_BASE_URL + 'embeddings', { method: 'POST' }));
    assert.equal(sent, 14);
    assert.equal(assessHoldoutObservations(cases, observer.records, 7).status, 'incomplete');
  } finally { observer.restore(); globalThis.fetch = originalFetch; }
});

test('taxonomy setup failures and conflicting selections preserve safe seven-case failure evidence', () => {
  for (const args of [[], ['--holdout']]) {
    let result: any;
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'deploy/provider-evaluation.ts', '--live', '--taxonomy', ...args], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, MODEL_BASE_URL: 'secret-invalid-url-sentinel', MODEL_REASONING_EFFORT: 'none' }, stdio: ['ignore', 'pipe', 'pipe'],
      }); assert.fail('Must fail before inference');
    } catch (error) { result = error; }
    assert.equal(result.status, 1);
    assert(!`${result.stdout}${result.stderr}`.includes('secret-invalid-url-sentinel'));
    const report = JSON.parse(result.stdout);
    assert.equal(report.taxonomy_probe.manifest_sha256, taxonomyProbeSha256);
    assert.equal(report.cases.length, 7);
    assert(report.cases.every((item: any) => item.status === 'not_attempted' && item.rubric_passed === false));
    assert.equal(report.central_lifecycle.status, 'not_measured');
    assert.equal(report.cleanup.status, 'passed');
  }
});
