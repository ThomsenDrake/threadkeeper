import type { ExtractionResult } from '../packages/providers/src/index.ts';
import { evaluationCorpus, type EvaluationCase } from './provider-evaluation-corpus.ts';
import { evaluateMemoryRubric } from './provider-evaluation-rubric.ts';

const direct = evaluationCorpus.find(item => item.id === 'direct')!;
export const providerProbeEvent = {
  id: 'provider-check-user-1', text: direct.events.map(event => event.text).join(' '),
  author_role: 'user' as const, origin: 'user_explicit' as const, occurred_at: '2026-10-02T12:00:00Z',
};
const probeCase: EvaluationCase = { ...direct, id: 'provider-probe', events: [providerProbeEvent],
  expected: direct.expected.map(expected => ({ ...expected, source_event_id: providerProbeEvent.id })),
};
export function evaluateProviderProbe(memories: ExtractionResult['memories']) {
  const rubric = evaluateMemoryRubric(probeCase, memories.map(memory => ({ ...memory,
    effective_at: memory.effective_at ?? null, status: 'active',
    evidence: [{ event_id: memory.source_event_id, quote: memory.quote }],
  })));
  return { ...rubric, expected_deadline: rubric.expectations[0].matched, expected_preference: rubric.expectations[1].matched };
}

// Exact synthetic capability prompts should not pass unrelated nonempty replies,
// truncated completions, tool calls, or extra properties in the requested shape.
export function validateProbeContent(kind: 'chat' | 'json_object' | 'json_schema', content: string | null | undefined,
  finishReason: string | null | undefined, hasToolCalls: boolean): boolean {
  if (finishReason !== 'stop' || hasToolCalls) return false;
  if (kind === 'chat') return content?.trim() === 'READY';
  let value: unknown;
  try { value = JSON.parse(content ?? ''); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  return kind === 'json_object' ? keys === 'deadline,ok' && record.ok === true && record.deadline === '2026-10-20'
    : keys === 'memories' && Array.isArray(record.memories) && record.memories.length === 0;
}
