import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { assertLearnedArchiveHistory, assertLearnedDeadlineHistory, assertLearnedDeletionPreview,
  assertLearnedExtraction, directLearnedCase, learnedDetail } from '../deploy/integration/learned-assertions.ts';

const project = 'synthetic-direct-assertion-check';
async function fixture(t: TestContext) {
  const database = await createTestDatabase(); t.after(() => database.close());
  const store = createStore(database.db);
  const owner: Auth = { ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null };
  const writer = { ...owner, clientId: 'synthetic-writer', permissions: ['read', 'capture'], projects: [project] };
  const receipt = await store.capture(writer, { idempotency_key: randomUUID(), project_id: project, subject: 'self', events: directLearnedCase.events });
  await store.processJob({ async extract() { return { model: 'nvidia/Nemotron-3_5-Lightning', memories: directLearnedCase.events.map((event, index) => ({
    statement: event.text, quote: event.text, source_event_id: event.id, origin: event.origin, kind: index === 0 ? 'fact' as const : 'preference' as const,
  })) }; } });
  const memories = (await store.list(owner, { project_id: project })).memories;
  const sources = await Promise.all(receipt.source_ids.map((id: string) => store.getSource(writer, id)));
  const learned = assertLearnedExtraction(memories, sources, project, writer.clientId);
  return { store, owner, writer, receipt, memories, ...learned };
}

test('native learned acceptance rejects wrong values, swapped relationships and source bindings', async t => {
  const { memories, sources, writer } = await fixture(t);
  for (const statement of [
    'The Lumen demo deadline is October 20, 2028.',
    'The Lumen demo starts on October 20, 2026 and its deadline is later.',
    'The Aurora demo deadline is October 20, 2026.',
  ]) {
    const corrupted = structuredClone(memories);
    corrupted.find(memory => memory.kind === 'fact')!.statement = statement;
    assert.throws(() => assertLearnedExtraction(corrupted, sources, project, writer.clientId));
  }
  const wrongScope = structuredClone(memories);
  wrongScope.find(memory => memory.kind === 'preference')!.statement = 'I prefer short paragraphs for shopping lists.';
  assert.throws(() => assertLearnedExtraction(wrongScope, sources, project, writer.clientId));
  const wrongSource = structuredClone(memories);
  wrongSource[0].evidence = wrongSource[1].evidence;
  assert.throws(() => assertLearnedExtraction(wrongSource, sources, project, writer.clientId));
  const changedSource = structuredClone(sources); changedSource[0].text += ' An unrecorded addition.';
  assert.throws(() => assertLearnedExtraction(memories, changedSource, project, writer.clientId));
  assert.throws(() => assertLearnedExtraction([...memories, memories[0]], sources, project, writer.clientId));
});

test('native preview and history assertions detect misleading impact and lost original evidence', async t => {
  const { store, owner, writer, receipt, sources, deadline, preference } = await fixture(t);
  const original = learnedDetail(await store.detail(owner, deadline.id));
  const deadlineSource = sources.find(source => source.id === deadline.evidence[0].source_id)!;
  const preferenceSource = sources.find(source => source.id === preference.evidence[0].source_id)!;
  const { memory: changed } = await store.correct(owner, deadline.id, { expected_revision: 1, statement: 'The Lumen demo deadline is October 27, 2026.' });
  assertLearnedDeadlineHistory(await store.detail(owner, deadline.id), original, changed);
  const preview = assertLearnedDeletionPreview(await store.previewRemoval(owner, preference.id), preference, preferenceSource, deadlineSource.id, receipt.job_id!);
  const corruptions: Array<(value: typeof preview) => void> = [
    value => { value.target.id = deadline.id; },
    value => { value.memories = []; },
    value => { value.sources[0].text = 'Wrong preview source'; },
    value => { value.revision_count = 0; },
    value => { value.evidence_count = 0; },
    value => { value.jobs = []; },
    value => { value.jobs[0].affected_source_ids.push(deadlineSource.id); },
    value => { value.jobs[0].source_ids = [preferenceSource.id]; },
  ];
  for (const corrupt of corruptions) {
    const bad = structuredClone(preview); corrupt(bad);
    assert.throws(() => assertLearnedDeletionPreview(bad, preference, preferenceSource, deadlineSource.id, receipt.job_id!));
  }
  await store.remove(owner, preference.id, { expected_revision: 1, preview_hash: preview.preview_hash });
  const detail = assertLearnedDeadlineHistory(await store.detail(owner, deadline.id), original, changed);
  assert.deepEqual(await store.getSource(writer, deadlineSource.id), { ...deadlineSource, extraction_blocked: true });
  const historyCorruptions: Array<(value: typeof detail) => void> = [
    value => { value.sources = value.sources.filter(source => source.id !== deadlineSource.id); },
    value => { value.sources.find(source => source.id === deadlineSource.id)!.text = changed.statement; },
    value => { value.revisions = value.revisions.filter(revision => revision.revision !== 1); },
    value => { value.revisions[0].statement = changed.statement; },
    value => { value.evidence = value.evidence.filter(evidence => evidence.revision !== 1); },
    value => { value.evidence[0].quote = changed.statement; },
  ];
  for (const corrupt of historyCorruptions) {
    const bad = structuredClone(detail); corrupt(bad);
    assert.throws(() => assertLearnedDeadlineHistory(bad, original, changed));
  }
  const archive = assertLearnedArchiveHistory(await store.export(owner), detail);
  for (const collection of ['sources', 'revisions', 'evidence'] as const) {
    const bad = structuredClone(archive); bad[collection] = [];
    assert.throws(() => assertLearnedArchiveHistory(bad, detail), `Export must retain ${collection}`);
  }
});
