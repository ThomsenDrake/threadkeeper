import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SourceEvent } from '../packages/contracts/src/index.ts';
import { normalizeCaptureSource } from '../packages/core/src/capture.ts';
import { assertHoldoutRecords } from '../deploy/provider-holdout-checks.ts';

test('capture admission and provenance oracle share method precedence and unknown time', () => {
  const event: SourceEvent = { id: 'event', text: 'Synthetic source', author_role: 'user', origin: 'user_explicit', capture_method: 'client_summary' };
  for (const [input, clientId, method] of [
    [event, 'writer', 'client_summary'],
    [{ ...event, capture_method: undefined }, 'writer', 'explicit_capture'],
    [{ ...event, origin: 'agent_reported', capture_method: 'explicit_capture' }, 'writer', 'client_summary'],
    [{ ...event, origin: 'agent_reported' }, 'profile', 'profile_entry'],
  ] as const) {
    const normalized = normalizeCaptureSource(input, clientId);
    assert.deepEqual(normalized, { capture_method: method, occurred_at: null });
    const source = { id: 'source', event_id: input.id, text: input.text, author_role: input.author_role, origin: input.origin,
      client_id: clientId, project_id: 'project', subject: 'self', ...normalized, extraction_blocked: false,
      checksum: createHash('sha256').update(input.text).digest('hex'), recorded_at: '2026-10-04T08:00:00Z' };
    const item = { id: 'case', events: [input], expected: [] };
    assertHoldoutRecords(item, [], [source], { project: 'project', client_id: clientId });
    assert.throws(() => assertHoldoutRecords(item, [], [{ ...source, capture_method: 'wrong' }], { project: 'project', client_id: clientId }));
  }
});
