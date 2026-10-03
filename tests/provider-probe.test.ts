import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateProviderProbe, providerProbeEvent, validateProbeContent } from '../deploy/provider-probe-rubric.ts';

const valid = () => [
  { statement: 'The Lumen demo deadline is October 20, 2026.', kind: 'fact' as const,
    source_event_id: providerProbeEvent.id, quote: 'The Lumen demo deadline is October 20, 2026.', origin: 'user_explicit' as const },
  { statement: 'I prefer short paragraphs when writing project updates.', kind: 'preference' as const,
    source_event_id: providerProbeEvent.id, quote: 'I prefer short paragraphs when writing project updates.', origin: 'user_explicit' as const },
];
test('provider probe shares the corpus full-date, subject, scope, quote and distinct-record checks', () => {
  assert(evaluateProviderProbe(valid()).rubric_passed);
  for (const date of ['October 20, 2039', 'October 20', '20 October 2039', '2039-10-20']) {
    const values = valid(); values[0].statement = `The Lumen demo deadline is ${date}.`;
    const result = evaluateProviderProbe(values); assert(!result.expected_deadline); assert(result.expected_preference);
  }
  const wrongSubject = valid(); wrongSubject[0].statement = 'My birthday is October 20, 2026.';
  assert(!evaluateProviderProbe(wrongSubject).rubric_passed);
  const unrelatedQuote = valid(); unrelatedQuote[0].quote = unrelatedQuote[1].quote;
  assert(!evaluateProviderProbe(unrelatedQuote).rubric_passed);
  const combined = valid(); combined[0].statement += ' ' + combined[1].statement;
  assert(!evaluateProviderProbe(combined.slice(0, 1)).rubric_passed);
  assert(!evaluateProviderProbe([...valid(), valid()[0]]).rubric_passed);
});

test('capability probes require exact content, schema and successful completion', () => {
  for (const [kind, content] of [['chat', 'READY'], ['json_object', '{"ok":true,"deadline":"2026-10-20"}'], ['json_schema', '{"memories":[]}']] as const) {
    assert(validateProbeContent(kind, content, 'stop', false));
    assert(!validateProbeContent(kind, content, 'length', false));
    assert(!validateProbeContent(kind, content, 'stop', true));
  }
  assert(!validateProbeContent('chat', 'NOT_READY', 'stop', false));
  assert(!validateProbeContent('json_object', '{"ok":true,"deadline":"2026-10-20","extra":true}', 'stop', false));
  assert(!validateProbeContent('json_schema', '{"memories":[],"unexpected":true}', 'stop', false));
});
