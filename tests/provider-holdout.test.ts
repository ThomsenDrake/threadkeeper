import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { extractionHoldout, extractionHoldoutSha256, extractionHoldoutManifest, assertHoldoutConfig } from '../deploy/provider-extraction-holdout.ts';
import { evaluateHoldoutOutcome, assertHoldoutRecords, holdoutRequestLimits, assessHoldoutObservations } from '../deploy/provider-holdout-checks.ts';
import { evaluateMemoryRubric, type EvaluationMemory } from '../deploy/provider-evaluation-rubric.ts';
import { installDirectProviderObserver, type ProviderObservation } from '../deploy/direct-provider-observer.mjs';
import { providerConfigFromEnv, DEFAULT_MODEL_ID, DEFAULT_MODEL_BASE_URL } from '../packages/providers/src/index.ts';

// Human-authored admissible examples; no provider outputs inform these labels.
const faithful = [
  'The assistant suggested holding the Cedar workshop in the west room.',
  'The user is unavailable for meetings before 10:00.',
  'The user prefers one table for the Cedar workshop notes.',
  'For the Cedar workshop notes, I prefer a single table.',
  'I prefer asynchronous check-ins.',
  'The user will use the south entrance from August 19, 2033.',
  "The user's Solstice handoff is due on 12 September 2034.",
];
function memories(index: number): EvaluationMemory[] {
  const item = extractionHoldout[index];
  return item.expected.map(expected => ({ statement: faithful[index], kind: expected.kind!, origin: expected.origin, status: expected.status,
    effective_at: expected.effective_at ?? null, evidence: [{ event_id: expected.source_event_id, quote: item.events.find(event => event.id === expected.source_event_id)!.text }],
  }));
}
test('frozen holdout accepts declared faithful variants, correct metadata, and completed empty extraction', () => {
  assert.equal(extractionHoldout.length, 8);
  assert.equal(new Set(extractionHoldout.map(item => item.id)).size, 8);
  assert.equal(extractionHoldoutSha256, createHash('sha256').update(JSON.stringify(extractionHoldoutManifest)).digest('hex'));
  for (const [index, item] of extractionHoldout.entries()) {
    assert(evaluateHoldoutOutcome(item, memories(index), { status: 'complete', accepted: item.expected.length }).rubric_passed, item.id);
    assert(!evaluateHoldoutOutcome(item, memories(index), { status: 'failed', accepted: 0 }).rubric_passed, item.id);
    assert(!evaluateHoldoutOutcome(item, memories(index), { status: 'complete', accepted: 9 }).rubric_passed, item.id);
  }
  for (const date of ['2033-08-19', 'August 19, 2033', '19 August 2033']) {
    const values = memories(5); values[0].statement = `Effective from ${date}, I use the south entrance.`;
    assert(evaluateMemoryRubric(extractionHoldout[5], values).rubric_passed);
  }
  const utc = memories(4); utc[0].effective_at = '2032-06-18T13:15:00Z';
  assert(evaluateMemoryRubric(extractionHoldout[4], utc).rubric_passed);
  const negative = memories(1); negative[0].statement = 'I am not available for meetings before 10:00.';
  assert(evaluateMemoryRubric(extractionHoldout[1], negative).rubric_passed, 'No inherited global not blacklist');
  for (const [index, statement] of [
    [0, 'The assistant suggests holding the Cedar workshop in the west room.'],
    [1, 'I am unavailable before 10:00 for meetings.'],
    [1, 'The user cannot participate in meetings before 10:00.'],
    [2, 'The user prefers Cedar workshop notes in a single table.'],
    [5, 'Beginning on 19 August 2033, I use the south entrance.'],
    [5, 'I start using the south entrance on 2033-08-19.'],
    [6, 'The Solstice handoff is due on 2034-09-12.'],
    [6, 'The deadline for my Solstice handoff is September 12, 2034.'],
  ] as const) {
    const values = memories(index); values[0].statement = statement;
    assert(evaluateMemoryRubric(extractionHoldout[index], values).rubric_passed, statement);
  }
});

test('whole statements reject invented agreement, windows, scope, quantity and date relationships', () => {
  const corruptions: Array<[number, string]> = [
    [0, 'The assistant suggested moving the Cedar workshop to the west room.'],
    [0, 'The Cedar workshop will be held in the west room.'],
    [1, 'The user is available for meetings after 10:00.'],
    [1, 'The user is unavailable for meetings before 10:00 and available afterward.'],
    [2, 'The user prefers tables for the Cedar workshop notes.'],
    [3, 'The user prefers one table for the Cedar workshop budget.'],
    [4, 'I prefer asynchronous check-ins on Mondays.'],
    [5, 'The user uses the south entrance.'],
    [5, 'The user uses the south entrance until August 19, 2033.'],
    [5, 'The user uses the south entrance daily from August 19, 2033.'],
    [6, "The user's Solstice handoff starts on 12 September 2034."],
    [6, "The user's Solstice handoff is due on 12 September 2035."],
  ];
  for (const [index, statement] of corruptions) {
    const values = memories(index); values[0].statement = statement;
    assert(!evaluateMemoryRubric(extractionHoldout[index], values).rubric_passed, statement);
  }
  for (const [index, item] of extractionHoldout.entries()) {
    const values = memories(index);
    values.push({ statement: 'The user asked about the implications.', kind: 'fact', origin: 'user_explicit', status: 'active', effective_at: null,
      evidence: [{ event_id: item.events[0].id, quote: item.events[0].text }] });
    assert(!evaluateMemoryRubric(item, values).rubric_passed, `${item.id}: unexpected record`);
  }
});

test('source slots reject wrong evidence and taxonomy/time metadata without silently changing labels', () => {
  for (const [index, item] of extractionHoldout.entries()) {
    if (!item.expected.length) continue;
    for (const change of [(value: EvaluationMemory) => { value.evidence[0].event_id = 'another-source'; },
      (value: EvaluationMemory) => { value.evidence[0].quote = 'Cedar'; },
      (value: EvaluationMemory) => { value.origin = 'user_confirmed'; },
      (value: EvaluationMemory) => { value.status = value.status === 'active' ? 'candidate' : 'active'; },
      (value: EvaluationMemory) => { value.kind = 'decision'; },
      (value: EvaluationMemory) => { value.effective_at = '2040-01-01T00:00:00Z'; }]) {
      const values = memories(index); change(values[0]);
      assert(!evaluateMemoryRubric(item, values).rubric_passed, item.id);
    }
  }
  const values = memories(4); values[0].evidence[0].quote = 'I prefer asynchronous check-ins';
  assert(!evaluateMemoryRubric(extractionHoldout[4], values).rubric_passed, 'Full supporting timestamp quote is required');
});

test('canonical recall provenance is independently bound to full source content and capture scope', () => {
  const item = extractionHoldout[1], event = item.events[0];
  const source = { id: 'source', event_id: event.id, client_id: 'writer', project_id: 'project', subject: 'self', text: event.text,
    author_role: event.author_role, origin: event.origin, occurred_at: event.occurred_at, recorded_at: '2026-10-03T12:01:00Z',
    checksum: createHash('sha256').update(event.text).digest('hex'), extraction_blocked: false, capture_method: 'explicit_capture' };
  const memory = { ...memories(1)[0], id: 'memory', project_id: 'project', subject: 'self', revision: 1, authoritative: false,
    extractor: DEFAULT_MODEL_ID, created_at: '2026-10-03T12:01:02Z', updated_at: '2026-10-03T12:01:02Z',
    evidence: [{ source_id: source.id, quote: event.text, client_id: source.client_id, author_role: source.author_role, origin: source.origin,
      capture_method: source.capture_method, occurred_at: source.occurred_at, recorded_at: source.recorded_at }] };
  const check = (values: any[], sources: any[]) => assertHoldoutRecords(item, values, sources, { project: 'project', client_id: 'writer' });
  check([memory], [source]);
  for (const field of ['client_id', 'origin', 'author_role', 'capture_method']) {
    const wrong = structuredClone(memory); (wrong.evidence[0] as any)[field] = 'wrong';
    assert.throws(() => check([wrong], [source]));
  }
  assert.throws(() => check([{ ...memory, subject: 'someone-else' }], [source]));
  assert.throws(() => check([memory], [{ ...source, checksum: '0'.repeat(64) }]));
  assert.throws(() => check([memory], [{ ...source, text: 'Changed source' }]));
  assert.throws(() => check([memory, memory], [source]));
});

test('holdout configuration rejects drift and its observer sends at most16 chats and zero embeddings', async () => {
  const config = providerConfigFromEnv({ MODEL_REASONING_EFFORT: 'none' });
  assertHoldoutConfig(config);
  for (const change of [{ baseUrl: 'https://example.invalid/v1/' }, { modelId: 'other' }, { reasoningEffort: undefined },
    { maxOutputTokens: 8192 }, { structuredOutput: true }, { jsonObject: false }]) assert.throws(() => assertHoldoutConfig({ ...config, ...change }));
  const saved = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async () => { sent++; return Response.json({ model: DEFAULT_MODEL_ID, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); };
  const observer = installDirectProviderObserver({ baseUrl: DEFAULT_MODEL_BASE_URL, limits: holdoutRequestLimits });
  try {
    for (let i = 0; i < 16; i++) await fetch(DEFAULT_MODEL_BASE_URL + 'chat/completions', { method: 'POST', body: JSON.stringify({ model: DEFAULT_MODEL_ID }) });
    await assert.rejects(fetch(DEFAULT_MODEL_BASE_URL + 'chat/completions', { method: 'POST' }));
    await assert.rejects(fetch(DEFAULT_MODEL_BASE_URL + 'embeddings', { method: 'POST' }));
    assert.equal(sent, 16);
    assert.equal(observer.records.filter(record => record.sent).length, 16);
    assert.equal(observer.records.filter(record => !record.sent).length, 2);
  } finally { observer.restore(); globalThis.fetch = saved; }
});

test('holdout setup failure emits all eight unattempted cases safely without provider or database work', () => {
  let result: any;
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'deploy/provider-evaluation.ts', '--live', '--holdout'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, MODEL_BASE_URL: 'invalid-sensitive-setup-sentinel', MODEL_REASONING_EFFORT: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('Invalid configuration must fail');
  } catch (error: any) { result = error; }
  assert.equal(result.status, 1);
  assert(!`${result.stdout}${result.stderr}`.includes('invalid-sensitive-setup-sentinel'));
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.cases.map((item: any) => item.id), extractionHoldout.map(item => item.id));
  assert(report.cases.every((item: any) => item.status === 'not_attempted' && item.rubric_passed === false));
  assert.equal(report.central_lifecycle.status, 'not_measured');
  assert.equal(report.cleanup.status, 'passed');
});

test('observation completeness is independent of rubric scores and preserves failed repairs', () => {
  const records: ProviderObservation[] = Array.from({ length: 8 }, (_, index) => ({ event: 'direct_provider_request', ordinal: index + 1,
    path: 'chat/completions', method: 'POST', started_at: '2026-10-03T12:00:00Z', sent: true, elapsed_ms: 1,
    outcome: 'http_response', http_status: 200, usage_status: 'reported', requested_model: DEFAULT_MODEL_ID,
    returned_model: DEFAULT_MODEL_ID, returned_model_matches: true, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }));
  const assess = (values: ProviderObservation[]) => assessHoldoutObservations(values.map(record => ({ provider_attempts: [record] })), values);
  assert.equal(assess(records).status, 'complete');
  for (const change of [{ returned_model: undefined, returned_model_matches: undefined }, { requested_model: 'other' }, { path: 'embeddings' },
    { usage_status: 'absent' as const, usage: undefined }, { sent: false }, { ordinal: 99 }]) {
    const values = structuredClone(records); Object.assign(values[0], change);
    assert.equal(assess(values).status, 'incomplete');
  }
  const repair = { ...records[0], ordinal: 2, http_status: 503, usage_status: 'absent' as const, usage: undefined };
  const withRepair = [records[0], repair, ...records.slice(1).map(record => ({ ...record, ordinal: record.ordinal + 1 }))];
  const cases = [{ provider_attempts: withRepair.slice(0, 2) }, ...withRepair.slice(2).map(record => ({ provider_attempts: [record] }))];
  assert.deepEqual(assessHoldoutObservations(cases, withRepair).issues, ['incomplete_token_accounting']);
  assert.equal(withRepair[1], repair, 'Do not discard the unsuccessful original attempt');
  assert(assessHoldoutObservations(cases.slice(1), withRepair).issues.includes('unassigned_provider_attempt'));
});
