import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractionHoldout, extractionHoldoutManifest, extractionHoldoutSha256 } from './provider-extraction-holdout.ts';

import { frozenManifestCases } from './provider-evaluation-corpus.ts';

// Preserve the frozen v1 labels and source text. Only provider-visible event
// identifiers and their assessment references change; no outcome is regraded.
let nextEvent = 1;
export const extractionHoldoutV2 = structuredClone(extractionHoldout).map(item => {
  const ids = new Map(item.events.map(event => [event.id, String(nextEvent++)]));
  for (const event of item.events) event.id = ids.get(event.id)!;
  for (const expected of item.expected) {
    const id = ids.get(expected.source_event_id);
    assert(id, 'Holdout expectation must reference its own source');
    expected.source_event_id = id;
  }
  return item;
});

export const extractionHoldoutV2Manifest = {
  ...structuredClone(extractionHoldoutManifest),
  id: 'threadkeeper.extraction-holdout.v2',
  parent_manifest_sha256: extractionHoldoutSha256,
  cases: frozenManifestCases(extractionHoldoutV2),
};
export const extractionHoldoutV2Sha256 = createHash('sha256').update(JSON.stringify(extractionHoldoutV2Manifest)).digest('hex');
