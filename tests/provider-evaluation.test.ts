import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evaluationCorpus, type EvaluationCase } from '../deploy/provider-evaluation-corpus.ts';
import { evaluateMemoryRubric, type EvaluationMemory } from '../deploy/provider-evaluation-rubric.ts';

const recorded = JSON.parse(await readFile(new URL('../docs/measurements/nebius-direct-evaluation.json', import.meta.url), 'utf8')).corpus.cases;
const item = (id: string) => evaluationCorpus.find(value => value.id === id)!;
const memories = (id: string): EvaluationMemory[] => structuredClone(recorded.find((value: any) => value.id === id).memories);

test('the saved final direct observations satisfy source-bound distinct-record rubrics', () => {
  assert.deepEqual(recorded.map((value: any) => value.id), evaluationCorpus.map(value => value.id));
  for (const entry of evaluationCorpus) assert(evaluateMemoryRubric(entry, memories(entry.id)).rubric_passed, entry.id);
});

test('paraphrased dialogue records fail even without the forbidden word', () => {
  const proposal = memories('proposal');
  const question = item('proposal').events[1];
  const extra = { statement: 'The user asked about the consequences of the change.', kind: 'fact', origin: 'user_explicit', effective_at: null,
    evidence: [{ event_id: question.id, quote: question.text }] };
  assert(!evaluateMemoryRubric(item('proposal'), [...proposal, extra]).rubric_passed);
  // Keeping the expected words while citing the wrong source also fails.
  proposal[0].evidence = extra.evidence;
  assert(!evaluateMemoryRubric(item('proposal'), proposal).rubric_passed);
});

test('timestamped deadlines must retain the complete value in the same statement', () => {
  for (const statement of ['The Harbor review has a due date.', 'The Harbor review is due on January 14, 2027.', 'The Harbor review is due at 2027-01-14T17:30:00+01:00.']) {
    const values = memories('deadline-timestamp'); values[0].statement = statement;
    assert(!evaluateMemoryRubric(item('deadline-timestamp'), values).rubric_passed);
  }
  const utc = memories('deadline-timestamp'); utc[0].statement = 'The Harbor review is due at 2027-01-14T15:30:00Z.';
  assert(evaluateMemoryRubric(item('deadline-timestamp'), utc).rubric_passed);
});

test('date-only clauses stay together and conflicting assertions stay separate', () => {
  const split = memories('effective-date-only');
  split.push({ ...structuredClone(split[0]), statement: 'The start date is February 4, 2027.' });
  split[0].statement = 'I prefer afternoon meetings.';
  assert(!evaluateMemoryRubric(item('effective-date-only'), split).rubric_passed);
  const conflict = memories('conflict');
  assert(evaluateMemoryRubric(item('conflict'), conflict.reverse()).rubric_passed);
  conflict[0].statement = 'The Meridian deadline is October 20 or October 27, 2026.';
  assert(!evaluateMemoryRubric(item('conflict'), conflict.slice(0, 1)).rubric_passed);
  conflict[1].evidence = structuredClone(conflict[0].evidence);
  assert(!evaluateMemoryRubric(item('conflict'), conflict).rubric_passed);
});

test('distinct matching handles overlapping slots and rejects reuse or fabricated evidence', () => {
  const source = { id: 'source', text: 'Morning or afternoon meetings.', origin: 'user_explicit' as const, author_role: 'user' as const };
  const entry: EvaluationCase = { id: 'overlap', events: [source], expected: [
    { source_event_id: source.id, pattern: 'morning|afternoon', origin: 'user_explicit' },
    { source_event_id: source.id, pattern: 'morning', origin: 'user_explicit' },
  ] };
  const values: EvaluationMemory[] = ['Morning meetings.', 'Afternoon meetings.'].map(statement => ({ statement, kind: 'fact', origin: 'user_explicit', effective_at: null,
    evidence: [{ event_id: source.id, quote: source.text }] }));
  assert(evaluateMemoryRubric(entry, values).rubric_passed, 'An earlier broad slot can move to the second record.');
  values[1].statement = 'Unrelated context.';
  assert(!evaluateMemoryRubric(entry, values).rubric_passed, 'One record cannot fill both slots.');
  values[1].statement = 'Afternoon meetings.';
  values[1].evidence[0].quote = 'Fabricated quotation';
  assert(!evaluateMemoryRubric(entry, values).rubric_passed);
});
