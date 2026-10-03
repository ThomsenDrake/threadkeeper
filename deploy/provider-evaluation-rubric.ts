import type { EvaluationCase } from './provider-evaluation-corpus.ts';

export type EvaluationMemory = {
  statement: string; kind: string; origin: string; status?: string; effective_at: string | null;
  evidence: Array<{ event_id?: string; quote: string }>;
};

// Each fixed expected slot describes one complete memory. Match slots to
// distinct records so a combined assertion cannot satisfy multiple slots.
// Every returned record must fill a slot; extra dialogue facts fail even when
// paraphrased or attributed to another event.
export function evaluateMemoryRubric(item: EvaluationCase, memories: EvaluationMemory[]) {
  const candidates = item.expected.map(expected => memories.flatMap((memory, index) => {
    const patterns = [expected.pattern, ...(expected.and_patterns ?? [])];
    const matches = patterns.every(pattern => new RegExp(pattern, 'i').test(memory.statement))
      && (expected.status === undefined || memory.status === expected.status)
      && memory.origin === expected.origin && (!expected.kind || memory.kind === expected.kind)
      && memory.evidence.length === 1 && memory.evidence[0].event_id === expected.source_event_id
      && [...patterns, ...(expected.quote_patterns ?? [])].every(pattern => new RegExp(pattern, 'i').test(memory.evidence[0].quote))
      && (expected.effective_at === undefined || (expected.effective_at === null ? memory.effective_at === null
        : typeof memory.effective_at === 'string' && Date.parse(memory.effective_at) === Date.parse(expected.effective_at)));
    return matches ? [index] : [];
  }));
  const assigned = new Map<number, number>();
  function assign(slot: number, visited: Set<number>): boolean {
    for (const memory of candidates[slot]) {
      if (visited.has(memory)) continue;
      visited.add(memory);
      const previous = assigned.get(memory);
      if (previous === undefined || assign(previous, visited)) { assigned.set(memory, slot); return true; }
    }
    return false;
  }
  for (let slot = 0; slot < item.expected.length; slot++) assign(slot, new Set());
  const matched = new Map([...assigned].map(([memory, slot]) => [slot, memory]));
  const expectations = item.expected.map((expected, slot) => ({ ...expected,
    matched: matched.has(slot), matched_memory_index: matched.get(slot) ?? null,
  }));
  const forbidden_matches = (item.forbidden ?? []).filter(pattern => memories.some(memory => new RegExp(pattern, 'i').test(memory.statement)));
  const events = new Map(item.events.map(event => [event.id, event]));
  const exact_evidence = memories.every(memory => memory.evidence.length === 1 && memory.evidence.every(evidence =>
    Boolean(evidence.quote) && evidence.event_id !== undefined && events.get(evidence.event_id)?.text.includes(evidence.quote)));
  const memory_count_matches = memories.length === item.expected.length;
  return { expectations, forbidden_matches, exact_evidence, memory_count_matches,
    rubric_passed: memory_count_matches && expectations.every(check => check.matched) && !forbidden_matches.length && exact_evidence,
  };
}
