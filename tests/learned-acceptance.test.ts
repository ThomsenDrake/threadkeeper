import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createStore, DomainError, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { assertLearnedArchiveHistory, assertLearnedDeadlineHistory, assertLearnedDeletionPreview,
  assertLearnedExtraction, assertLearnedRecall, directLearnedCase, learnedDetail, learnedRecallRecord } from '../deploy/integration/learned-assertions.ts';

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
  // Seed an earlier admission checkpoint before reading the baseline. The
  // correction tests must prove time advancement without depending on a tick
  // between two fast local transactions or adding a wall-clock sleep.
  const admittedAt = new Date(Date.now() - 60_000).toISOString();
  await database.db.query('UPDATE tk_memories SET created_at=$1,updated_at=$1 WHERE owner_id=$2', [admittedAt, owner.ownerId]);
  await database.db.query('UPDATE tk_revisions SET created_at=$1 WHERE memory_id IN (SELECT id FROM tk_memories WHERE owner_id=$2)', [admittedAt, owner.ownerId]);
  await database.db.query('UPDATE tk_sources SET recorded_at=$1 WHERE owner_id=$2', [admittedAt, owner.ownerId]);
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
  for (const index of [0, 1]) {
    const invalidChecksum = structuredClone(sources); invalidChecksum[index].checksum = '0'.repeat(64);
    assert.throws(() => assertLearnedExtraction(memories, invalidChecksum, project, writer.clientId));
  }
  assert.throws(() => assertLearnedExtraction([...memories, memories[0]], sources, project, writer.clientId));
});

test('learned recalls must retain every canonical memory and evidence field', async t => {
  const { store, writer, owner, deadline, preference } = await fixture(t);
  const result = await store.search(writer, { project_id: project, source: deadline.evidence[0].source_id });
  const expected = [deadline, preference];
  assertLearnedRecall(result.memories, expected, deadline.id);
  assertLearnedRecall([learnedRecallRecord(learnedDetail(await store.detail(owner, deadline.id)))], expected, deadline.id);
  const corruptions: Array<(value: typeof deadline) => void> = [
    value => { value.statement = 'The Lumen demo deadline is October 20, 2028.'; },
    value => { value.project_id = 'another-project'; },
    value => { value.subject = 'someone-else'; },
    value => { value.kind = 'preference'; },
    value => { value.origin = 'inferred'; },
    value => { value.status = 'candidate'; },
    value => { value.revision = 2; },
    value => { value.authoritative = true; },
    value => { value.effective_at = '2030-01-01T00:00:00.000Z'; },
    value => { value.extractor = 'different-model'; },
    value => { value.created_at = '2030-01-01T00:00:00.000Z'; },
    value => { value.updated_at = '2030-01-01T00:00:00.000Z'; },
    value => { value.evidence = []; },
    value => { value.evidence[0].source_id = preference.evidence[0].source_id; },
    value => { value.evidence[0].quote = 'An unsupported quotation.'; },
    value => { value.evidence[0].client_id = 'wrong-client'; },
    value => { value.evidence[0].author_role = 'assistant'; },
    value => { value.evidence[0].origin = 'assistant_proposed'; },
    value => { value.evidence[0].capture_method = 'profile_correction'; },
    value => { value.evidence[0].occurred_at = null; },
    value => { value.evidence[0].recorded_at = '2030-01-01T00:00:00.000Z'; },
  ];
  for (const corrupt of corruptions) {
    const bad = structuredClone(deadline); corrupt(bad);
    assert.throws(() => assertLearnedRecall([bad], expected, deadline.id));
  }
  assert.throws(() => assertLearnedRecall([], expected, deadline.id));
  assert.throws(() => assertLearnedRecall([deadline, deadline], expected, deadline.id));
  assert.throws(() => assertLearnedRecall([deadline, { ...preference, id: 'unexpected-memory' }], expected, deadline.id));
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
  for (const event of [
    { ...directLearnedCase.events[1], text: 'Changed content under the forgotten identity.' },
    { ...directLearnedCase.events[1], id: 'fresh-forgotten-content-id', text: `  ${preferenceSource.text.toUpperCase()}\n` },
  ]) {
    await assert.rejects(store.capture(writer, { idempotency_key: randomUUID(), project_id: project, subject: 'self', events: [event], explicit_memories: [] }),
      error => error instanceof DomainError && error.status === 410 && error.code === 'deleted_source');
  }
  const detail = assertLearnedDeadlineHistory(await store.detail(owner, deadline.id), original, changed);
  assert.deepEqual(await store.getSource(writer, deadlineSource.id), { ...deadlineSource, extraction_blocked: true });
  const historyCorruptions: Array<(value: typeof detail) => void> = [
    value => { value.sources = value.sources.filter(source => source.id !== deadlineSource.id); },
    value => { value.sources.find(source => source.id === deadlineSource.id)!.text = changed.statement; },
    value => { value.revisions = value.revisions.filter(revision => revision.revision !== 1); },
    value => { value.revisions[0].statement = changed.statement; },
    value => { value.evidence = value.evidence.filter(evidence => evidence.revision !== 1); },
    value => { value.evidence[0].quote = changed.statement; },
    value => { value.sources.find(source => source.capture_method === 'profile_correction')!.checksum = '0'.repeat(64); },
    value => { value.sources.find(source => source.capture_method === 'profile_correction')!.event_id = 'wrong-correction-event'; },
    value => { value.sources.find(source => source.capture_method === 'profile_correction')!.occurred_at = original.memory.updated_at; },
    value => { value.sources.find(source => source.capture_method === 'profile_correction')!.recorded_at = original.memory.updated_at; },
    value => { value.revisions.find(revision => revision.revision === 2)!.created_at = original.memory.updated_at; },
  ];
  for (const corrupt of historyCorruptions) {
    const bad = structuredClone(detail); corrupt(bad);
    assert.throws(() => assertLearnedDeadlineHistory(bad, original, changed));
  }
  const wrongTime = structuredClone(detail), wrongChanged = structuredClone(changed);
  wrongChanged.effective_at = wrongTime.memory.effective_at = '2030-01-01T00:00:00.000Z';
  wrongTime.revisions.find(revision => revision.revision === 2)!.effective_at = wrongChanged.effective_at;
  assert.throws(() => assertLearnedDeadlineHistory(wrongTime, original, wrongChanged),
    'Mutually consistent changed/detail timestamps must not replace the original effective time');
  const wrongCreated = structuredClone(detail), wrongCreatedResponse = structuredClone(changed);
  wrongCreatedResponse.created_at = wrongCreated.memory.created_at = detail.memory.updated_at;
  assert.throws(() => assertLearnedDeadlineHistory(wrongCreated, original, wrongCreatedResponse),
    'A matching PATCH/detail creation-time rewrite must not replace the original checkpoint');
  for (const updatedAt of [original.memory.updated_at, new Date(Date.parse(original.memory.updated_at) - 1_000).toISOString()]) {
    const wrongUpdated = structuredClone(detail), wrongUpdatedResponse = structuredClone(changed);
    wrongUpdatedResponse.updated_at = wrongUpdated.memory.updated_at = updatedAt;
    const correction = wrongUpdated.sources.find(source => source.capture_method === 'profile_correction')!;
    correction.occurred_at = correction.recorded_at = updatedAt;
    wrongUpdated.revisions.find(revision => revision.revision === 2)!.created_at = updatedAt;
    assert.throws(() => assertLearnedDeadlineHistory(wrongUpdated, original, wrongUpdatedResponse),
      'Consistent correction timestamps must still advance the independently captured original checkpoint');
  }
  for (const changeSource of [true, false]) {
    const wrongEditor = structuredClone(detail);
    wrongEditor.revisions.find(revision => revision.revision === 2)!.editor_client_id = writer.clientId;
    if (changeSource) wrongEditor.sources.find(source => source.capture_method === 'profile_correction')!.client_id = writer.clientId;
    assert.throws(() => assertLearnedDeadlineHistory(wrongEditor, original, changed),
      'A matching non-profile source/editor pair must not authorize owner correction provenance');
  }
  const forgotten = { memory: preference, source: preferenceSource };
  const archive = assertLearnedArchiveHistory(await store.export(owner), detail, forgotten);
  // Exercise the portability contract itself in addition to the acceptance
  // assertions: a shape-valid wrong correction identity must fail import.
  const importedDatabase = await createTestDatabase(); t.after(() => importedDatabase.close());
  const importedStore = createStore(importedDatabase.db), importedOwner = { ...owner, ownerId: randomUUID() };
  const wrongIdentity = structuredClone(archive);
  wrongIdentity.sources.find(source => source.capture_method === 'profile_correction')!.event_id = 'wrong-correction-event';
  await assert.rejects(importedStore.import(importedOwner, wrongIdentity),
    error => error instanceof DomainError && error.code === 'invalid_authority');
  await importedStore.import(importedOwner, archive);
  const importedArchive = await importedStore.export(importedOwner);
  assertLearnedArchiveHistory(importedArchive, detail, forgotten);
  for (const collection of ['sources', 'revisions', 'evidence'] as const) {
    const bad = structuredClone(archive); bad[collection] = [];
    assert.throws(() => assertLearnedArchiveHistory(bad, detail, forgotten), `Export must retain ${collection}`);
  }
  for (const kind of ['source_identity', 'source_content', 'memory_content']) {
    const missing = structuredClone(archive); missing.tombstones = missing.tombstones.filter(tombstone => tombstone.kind !== kind);
    assert.throws(() => assertLearnedArchiveHistory(missing, detail, forgotten), `Missing ${kind} must fail`);
    const wrong = structuredClone(archive); wrong.tombstones.find(tombstone => tombstone.kind === kind)!.hash = '0'.repeat(64);
    assert.throws(() => assertLearnedArchiveHistory(wrong, detail, forgotten), `Wrong ${kind} hash must fail`);
  }
  const extra = structuredClone(archive); extra.tombstones.push({ ...extra.tombstones[0], hash: '1'.repeat(64) });
  assert.throws(() => assertLearnedArchiveHistory(extra, detail, forgotten), 'Unexpected deletion fingerprints must fail');
  for (const index of [0, 1]) {
    const wrongArchive = structuredClone(archive), wrongDetail = structuredClone(detail);
    wrongArchive.sources[index].checksum = '0'.repeat(64);
    wrongDetail.sources.find(source => source.id === wrongArchive.sources[index].id)!.checksum = '0'.repeat(64);
    assert.throws(() => assertLearnedArchiveHistory(wrongArchive, wrongDetail, forgotten), 'Matching corrupt export/detail checksums must still fail SHA-256 validation');
  }
});
