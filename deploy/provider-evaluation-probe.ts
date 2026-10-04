import assert from 'node:assert/strict';
import { evaluationCorpus, type EvaluationCase } from './provider-evaluation-corpus.ts';
import { evaluateMemoryRubric, type EvaluationMemory } from './provider-evaluation-rubric.ts';
import { extractionHoldout, extractionHoldoutManifest, extractionHoldoutSha256 } from './provider-extraction-holdout.ts';
import { extractionHoldoutV2, extractionHoldoutV2Manifest, extractionHoldoutV2Sha256 } from './provider-extraction-holdout-v2.ts';
import { taxonomyProbe, taxonomyProbeManifest, taxonomyProbeSha256 } from './provider-taxonomy-probe.ts';
import { evaluateTaxonomyOutcome } from './provider-taxonomy-checks.ts';
import { evaluateHoldoutOutcome } from './provider-holdout-checks.ts';

type Job = { status: string; accepted: number };
function scoredCases<T extends EvaluationCase>(cases: T[], evaluate: (item: T, memories: EvaluationMemory[], job: Job) => ReturnType<typeof evaluateMemoryRubric>) {
  return { cases, score: (index: number, memories: EvaluationMemory[], job: Job) => evaluate(cases[index], memories, job) };
}
const probes = {
  corpus: { ...scoredCases(evaluationCorpus, evaluateMemoryRubric), bounded: false as const, flags: [] },
  taxonomy: { ...scoredCases(taxonomyProbe, evaluateTaxonomyOutcome), bounded: true as const, flags: ['--taxonomy'],
    manifest: taxonomyProbeManifest, manifestSha256: taxonomyProbeSha256, metadataKey: 'taxonomy_probe',
    lifecycleReason: 'assertion_kind_probe_only', offlineOnly: false },
  holdoutV1: { ...scoredCases(extractionHoldout, evaluateHoldoutOutcome), bounded: true as const, flags: ['--holdout-v1'],
    manifest: extractionHoldoutManifest, manifestSha256: extractionHoldoutSha256, metadataKey: 'holdout',
    lifecycleReason: 'extraction_holdout_only', offlineOnly: true },
  holdoutV2: { ...scoredCases(extractionHoldoutV2, evaluateHoldoutOutcome), bounded: true as const, flags: ['--holdout'],
    manifest: extractionHoldoutV2Manifest, manifestSha256: extractionHoldoutV2Sha256, metadataKey: 'holdout',
    lifecycleReason: 'extraction_holdout_only', offlineOnly: false },

};

export function selectEvaluationProbe(argv: string[]) {
  // Priority preserves the selected probe's failure evidence on conflicting flags.
  const selected = Object.values(probes).filter(probe => probe.flags.some(flag => argv.includes(flag)));
  const probe = selected[0] ?? probes.corpus;
  const flags = Object.values(probes).flatMap(probe => probe.flags);
  return { probe, args: argv.filter(value => !flags.includes(value)), validateSelection(mode: string) {
    assert(selected.length <= 1, 'Select only one frozen probe');
    assert(!probe.bounded || !probe.offlineOnly || ['--requests', '--replay'].includes(mode), 'Legacy holdout supports offline requests/replay only');
  } };
}
