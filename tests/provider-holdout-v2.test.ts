import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { extractionHoldout, extractionHoldoutManifest, extractionHoldoutSha256 } from '../deploy/provider-extraction-holdout.ts';
import { extractionHoldoutV2, extractionHoldoutV2Manifest, extractionHoldoutV2Sha256 } from '../deploy/provider-extraction-holdout-v2.ts';
import { frozenManifestCases } from '../deploy/provider-evaluation-corpus.ts';
import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID } from '../packages/providers/src/index.ts';

test('v2 replaces every provider-visible event identifier without changing frozen v1 semantics', () => {
  assert.equal(extractionHoldoutSha256, '91503716bf7879c49e3763c68d62f1a94c14b7a4896121c84fe628adfe81f49e');
  assert.equal(extractionHoldoutV2Sha256, '6ca1d0be56b58451ff8ccfe4072338a34eb9efa34b905292529fd70fea7536ae');
  assert.equal(extractionHoldoutV2Manifest.id, 'threadkeeper.extraction-holdout.v2');
  assert.equal(extractionHoldoutV2Manifest.parent_manifest_sha256, extractionHoldoutSha256);
  assert.notEqual(extractionHoldoutV2Sha256, extractionHoldoutSha256);
  assert.equal(extractionHoldoutV2Sha256, createHash('sha256').update(JSON.stringify(extractionHoldoutV2Manifest)).digest('hex'));
  const restored = structuredClone(extractionHoldoutV2);
  const seen = new Set<string>();
  for (const [index, item] of restored.entries()) {
    const mapping = new Map(item.events.map((event, eventIndex) => [event.id, extractionHoldout[index].events[eventIndex].id]));
    for (const event of item.events) {
      assert.match(event.id, /^\d+$/);
      assert(!seen.has(event.id)); seen.add(event.id);
      event.id = mapping.get(event.id)!;
    }
    for (const expected of item.expected) expected.source_event_id = mapping.get(expected.source_event_id)!;
  }
  assert.equal(seen.size, 9);
  assert.deepEqual(restored, extractionHoldout);
  const { parent_manifest_sha256: _parent, ...v2 } = extractionHoldoutV2Manifest;
  assert.deepEqual({ ...v2, id: extractionHoldoutManifest.id, cases: frozenManifestCases(restored) }, extractionHoldoutManifest);
});

const environment = { ...process.env, NODE_OPTIONS: '', NEBIUS_API_KEY: '', MODEL_API_KEY: '',
  MODEL_BASE_URL: DEFAULT_MODEL_BASE_URL, MODEL_ID: DEFAULT_MODEL_ID, MODEL_REASONING_EFFORT: 'none' };
const args = ['--import', 'tsx', 'deploy/provider-evaluation.ts'];

test('actual generated v2 requests expose only opaque IDs and unchanged source context', { timeout: 60_000 }, () => {
  const report = JSON.parse(execFileSync(process.execPath, [...args, '--requests', '--holdout'], {
    cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8', stdio: 'pipe', maxBuffer: 2_000_000, timeout: 55_000,
  }));
  assert.equal(report.holdout.manifest_sha256, extractionHoldoutV2Sha256);
  assert.equal(report.cleanup.status, 'passed');
  assert.equal(report.cases.length, 8);
  const forbidden = extractionHoldout.flatMap(item => [item.id, ...item.events.map(event => event.id)]);
  for (const [index, item] of report.cases.entries()) {
    assert.equal(item.attempts.length, 1);
    const request = item.attempts[0].request;
    const serialized = JSON.stringify(request);
    for (const label of forbidden) assert(!serialized.includes(label), `Provider payload leaked ${label}`);
    assert(!serialized.includes(extractionHoldoutV2Sha256));
    const messages = request.messages.filter((message: any) => message.role === 'user');
    assert.equal(messages.length, 1);
    const context = JSON.parse(messages[0].content);
    assert.deepEqual(Object.keys(context).sort(), ['events', 'project_id', 'subject']);
    assert.equal(context.project_id, `project-${String(index + 1).padStart(2, '0')}`);
    assert.equal(context.subject, 'self');
    const expected = extractionHoldoutV2[index].events;
    assert.equal(context.events.length, expected.length);
    for (const [eventIndex, event] of context.events.entries()) {
      const { client_id, ...source } = event;
      assert.match(client_id, /^[a-f0-9-]{36}$/);
      assert.deepEqual(source, { ...expected[eventIndex], occurred_at: new Date(expected[eventIndex].occurred_at!).toISOString() });
    }
  }
});

test('legacy holdout cannot make live calls and version selectors cannot be combined', () => {
  for (const flags of [['--live', '--holdout-v1'], ['--holdout-v1'], ['--requests', '--holdout', '--holdout-v1']]) {
    let failure: any;
    try { execFileSync(process.execPath, [...args, ...flags], { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { failure = error; }
    assert.equal(failure?.status, 1);
    const report = JSON.parse(failure.stdout);
    assert.equal(report.holdout.manifest_sha256, extractionHoldoutSha256);
    assert(report.cases.every((item: any) => item.status === 'not_attempted'));
    assert.equal(report.provider_accounting?.direct_request_count ?? 0, 0);
  }
});
