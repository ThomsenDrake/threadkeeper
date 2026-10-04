import type { TaxonomyCase } from './provider-taxonomy-probe.ts';
import type { EvaluationMemory } from './provider-evaluation-rubric.ts';
import { evaluateHoldoutOutcome } from './provider-holdout-checks.ts';

// The frozen probe has zero or one slot per capture. Do not invent a semantic
// assignment for extra records; retain them and fail the content/count gate.
export function evaluateTaxonomyOutcome(item: TaxonomyCase, memories: EvaluationMemory[], job: { status: string; accepted: number }) {
  const rubric = evaluateHoldoutOutcome(item, memories, job);
  const measured = job.status === 'complete' && job.accepted === memories.length;
  const unmeasured = { content: 'not_measured', provenance: 'not_measured', taxonomy: 'not_measured' };
  let dimensions = unmeasured;
  if (measured) {
    if (!rubric.memory_count_matches) dimensions = { ...unmeasured, content: 'failed' };
    else {
      const pair = rubric.criteria[0]?.[0] ?? { content: true, provenance: true, taxonomy: true };
      dimensions = {
        content: pair.content && !rubric.forbidden_matches.length ? 'passed' : 'failed',
        provenance: pair.provenance && rubric.exact_evidence ? 'passed' : 'failed',
        taxonomy: pair.taxonomy ? 'passed' : 'failed',
      };
    }
  }
  return { ...rubric, assessment_dimensions: dimensions };
}
