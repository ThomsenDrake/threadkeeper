import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createStore, DomainError, type Auth } from '../packages/core/src/index.ts';
import type { CaptureInput, ExplicitMemory, ExportBundle } from '../packages/contracts/src/index.ts';
import { createTestDatabase } from './helpers.ts';

const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null });
const client = (profile: Auth): Auth => ({ ...profile, clientId: 'inference-client', permissions: ['capture', 'read'] });
const failure = (code: string) => (error: unknown) => error instanceof DomainError && error.status === 400 && error.code === code;
function inferred(text: string) {
  const eventId = randomUUID();
  const input: CaptureInput = { idempotency_key: randomUUID(), project_id: 'inference-project', subject: 'self',
    events: [{ id: eventId, text, author_role: 'assistant', origin: 'inferred' }] };
  const memory: ExplicitMemory = { statement: text, kind: 'fact', source_event_id: eventId, quote: text, origin: 'inferred' };
  return { input, memory };
}
function legacy(bundle: ExportBundle) {
  return { ...bundle, schema_version: 'threadkeeper.export.v1', revisions: bundle.revisions.map(({ kind: _kind, ...revision }) => revision) };
}

test('inferred evidence cannot become active through explicit capture or an alternate worker provider', async () => {
  const database = await createTestDatabase();
  const store = createStore(database.db), profile = owner(), writer = client(profile);
  try {
    const { input, memory } = inferred('The synthetic review may happen on Wednesday.');
    for (const author_role of ['user', 'assistant', 'system', 'unknown'] as const) {
      for (const origin of ['agent_reported', 'user_explicit', 'user_confirmed'] as const) {
        await assert.rejects(store.capture(writer, { ...input, events: [{ ...input.events[0], author_role }],
          explicit_memories: [memory, { ...memory, origin }] }),
        failure(origin === 'agent_reported' ? 'inference_misattribution' : 'author_misattribution'));
      }
    }
    const empty = await store.export(profile);
    assert.deepEqual([empty.sources, empty.memories, empty.revisions, empty.evidence], [[], [], [], []], 'Rejected batches roll back their valid first memory and source.');

    const receipt = await store.capture(writer, input);
    const result = await store.processJob({ extract: async () => ({ memories: [memory, { ...memory, origin: 'agent_reported' }] }) });
    assert.equal(result?.status, 'failed');
    assert(result && 'error_code' in result);
    assert.equal(result.error_code, 'inference_misattribution');
    assert.deepEqual((await store.captureStatus(profile, receipt.capture_id)).memory_ids, []);
    assert.deepEqual((await store.export(profile)).memories, []);
    assert.equal((await store.getSource(profile, receipt.source_ids[0])).origin, 'inferred');

    for (const origin of ['inferred', 'assistant_proposed'] as const) {
      const candidate = inferred(`Synthetic ${origin} candidate remains unconfirmed.`);
      const saved = await store.capture(writer, { ...candidate.input, explicit_memories: [{ ...candidate.memory, origin }] });
      const detail = await store.detail(profile, saved.memory_ids[0]);
      assert.equal(detail.memory.status, 'candidate');
      assert.equal(detail.memory.origin, origin);
    }
    assert.deepEqual((await store.search(writer, {})).memories, []);
  } finally { await database.close(); }
});

test('inferred-source import rejects active relabeling but preserves legacy candidates and separate owner evidence', async () => {
  const first = await createTestDatabase(), second = await createTestDatabase();
  const store = createStore(first.db), restored = createStore(second.db), profile = owner(), destination = owner();
  try {
    const candidate = inferred('The synthetic handoff may need an extra reviewer.');
    await store.capture(client(profile), { ...candidate.input, explicit_memories: [candidate.memory] });
    const bundle = await store.export(profile);
    const promoted = structuredClone(bundle);
    promoted.memories[0].origin = 'agent_reported'; promoted.memories[0].status = 'active';
    promoted.revisions[0].origin = 'agent_reported'; promoted.revisions[0].status = 'active';
    for (const invalid of [promoted, legacy(promoted)]) {
      await assert.rejects(restored.import(destination, invalid), failure('inference_misattribution'));
      const empty = await restored.export(destination);
      assert.deepEqual([empty.sources, empty.memories, empty.revisions, empty.evidence], [[], [], [], []]);
    }
    assert.equal((await restored.import(destination, legacy(bundle))).imported_memories, 1);
    assert.equal((await restored.import(destination, bundle)).existing_memories, 1);
    assert.deepEqual((await restored.search(destination, {})).memories, []);

    const reviewed = inferred('The synthetic launch may use a written checklist.');
    const receipt = await store.capture(client(profile), { ...reviewed.input, explicit_memories: [reviewed.memory] });
    const id = receipt.memory_ids[0];
    await store.review(profile, id, { action: 'confirm', expected_revision: 1 });
    await store.correct(profile, id, { statement: 'The synthetic launch uses a written checklist.', expected_revision: 2, kind: 'decision' });
    const confirmed = await store.export(profile);
    const invalidHistory = structuredClone(confirmed);
    invalidHistory.revisions.find(revision => revision.memory_id === id && revision.revision === 1)!.origin = 'agent_reported';
    await assert.rejects(restored.import(destination, invalidHistory), failure('inference_misattribution'));
    assert.equal((await restored.export(destination)).memories.length, 1, 'Invalid old attribution cannot be concealed by a valid current owner correction.');
    assert.equal((await restored.import(destination, confirmed)).imported_memories, 1);
    const detail = await restored.detail(destination, id);
    assert.deepEqual(detail.revisions.map(revision => revision.origin), ['inferred', 'user_confirmed', 'user_explicit']);
    assert.deepEqual(detail.sources.map(source => source.origin).sort(), ['inferred', 'user_confirmed', 'user_explicit'].sort());
    assert.deepEqual((await restored.search(destination, {})).memories.map(memory => [memory.id, memory.origin, memory.kind]), [[id, 'user_explicit', 'decision']]);
  } finally { await first.close(); await second.close(); }
});
