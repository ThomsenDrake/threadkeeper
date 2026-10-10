import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEvaluationProbe } from '../deploy/provider-evaluation-probe.ts';
import { evaluationCorpus } from '../deploy/provider-evaluation-corpus.ts';
import { extractionHoldoutSha256 } from '../deploy/provider-extraction-holdout.ts';
import { extractionHoldoutV2Sha256 } from '../deploy/provider-extraction-holdout-v2.ts';
import { taxonomyProbeSha256 } from '../deploy/provider-taxonomy-probe.ts';

test('probe selection owns corpus cases without frozen metadata and each frozen manifest', () => {
  const corpus = selectEvaluationProbe(['--requests']);
  assert.equal(corpus.probe.cases, evaluationCorpus);
  assert.equal(corpus.probe.bounded, false);
  assert.equal('manifest' in corpus.probe, false);
  assert.deepEqual(corpus.args, ['--requests']);
  for (const [flag, hash, count] of [
    ['--holdout-v1', extractionHoldoutSha256, 8],
    ['--holdout', extractionHoldoutV2Sha256, 8],
    ['--taxonomy', taxonomyProbeSha256, 7],
  ] as const) {
    const selection = selectEvaluationProbe(['--requests', flag]);
    selection.validateSelection('--requests');
    assert(selection.probe.bounded);
    assert.equal(selection.probe.manifestSha256, hash);
    assert.equal(selection.probe.cases.length, count);
    assert.deepEqual(selection.args, ['--requests']);
    const emptyIndex = selection.probe.cases.findIndex(item => !item.expected.length);
    assert(selection.probe.score(emptyIndex, [], { status: 'complete', accepted: 0 }).rubric_passed);
    assert(!selection.probe.score(emptyIndex, [], { status: 'failed', accepted: 0 }).rubric_passed);
  }
});

test('conflicts retain preferred failure-report probe and legacy live calls are rejected', () => {
  for (const flag of ['--holdout', '--holdout-v1']) {
    const selection = selectEvaluationProbe(['--taxonomy', flag]);
    assert(selection.probe.bounded);
    assert.equal(selection.probe.metadataKey, 'taxonomy_probe');
    assert.throws(() => selection.validateSelection('--requests'));
  }
  const legacy = selectEvaluationProbe(['--holdout', '--holdout-v1']);
  assert(legacy.probe.bounded);
  assert.equal(legacy.probe.manifestSha256, extractionHoldoutSha256);
  assert.throws(() => legacy.validateSelection('--requests'));
  assert.throws(() => selectEvaluationProbe(['--holdout-v1']).validateSelection('--live'));
});

test('runtime delivery projection keeps frozen availability rubrics and origin distinctions intact', () => {
  const { probe } = selectEvaluationProbe([]);
  const index = probe.cases.findIndex(item => item.id === 'proposal');
  const item = probe.cases[index];
  const source = item.events[0];
  const observed = [{ statement: source.text, kind: 'project_state', origin: 'assistant_proposed', status: 'active',
    effective_at: null, evidence: [{ event_id: source.id, quote: source.text }] }];
  const job = { status: 'complete', accepted: 1 };
  assert.equal(probe.score(index, observed, job).rubric_passed, false);
  assert.equal(probe.score(index, observed, job, true).rubric_passed, true);
  assert.equal(item.expected[0].status, 'candidate', 'Runtime projection must not mutate frozen expectations');
  assert.equal(probe.score(index, [{ ...observed[0], origin: 'user_explicit' }], job, true).rubric_passed, false);
  assert.equal(probe.score(index, [{ ...observed[0], origin: 'user_confirmed' }], job, true).rubric_passed, false);
});
