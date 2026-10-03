import assert from 'node:assert/strict';
import type { TaxonomyCase } from './provider-taxonomy-probe.ts';
import { evaluateMemoryCriteria, type EvaluationMemory } from './provider-evaluation-rubric.ts';
import { evaluateHoldoutOutcome } from './provider-holdout-checks.ts';

// The frozen probe has zero or one slot per capture. Do not invent a semantic
// assignment for extra records; retain them and fail the content/count gate.
export function evaluateTaxonomyOutcome(item: TaxonomyCase, memories: EvaluationMemory[], job: { status: string; accepted: number }) {
  assert(item.expected.length <= 1);
  const rubric = evaluateHoldoutOutcome(item, memories, job);
  const measured = job.status === 'complete' && job.accepted === memories.length;
  const pair = item.expected.length === 1 && memories.length === 1
    ? evaluateMemoryCriteria(item.expected[0], memories[0]) : undefined;
  const empty = item.expected.length === 0 && memories.length === 0;
  const dimensions = measured ? {
    content: empty || (pair?.content === true && !rubric.forbidden_matches.length) ? 'passed' : 'failed',
    provenance: empty ? 'passed' : pair ? pair.provenance && rubric.exact_evidence ? 'passed' : 'failed' : 'not_measured',
    taxonomy: empty ? 'passed' : pair ? pair.taxonomy ? 'passed' : 'failed' : 'not_measured',
  } : { content: 'not_measured', provenance: 'not_measured', taxonomy: 'not_measured' };
  return { ...rubric, assessment_dimensions: dimensions };
}
