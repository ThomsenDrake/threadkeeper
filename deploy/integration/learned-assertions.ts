import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DeletionPreviewSchema, EvidenceSchema, ExportSchema, ExportSourceSchema, MemorySchema, RevisionSchema } from '../../packages/contracts/src/index.ts';
import { memoryContent, sourceContent, sourceIdentity } from '../../packages/core/src/hashing.ts';
import { evaluationCorpus } from '../provider-evaluation-corpus.ts';
import { evaluateMemoryRubric } from '../provider-evaluation-rubric.ts';

export const directLearnedCase = evaluationCorpus.find(item => item.id === 'direct')!;
const model = 'nvidia/Nemotron-3_5-Lightning';
const ids = (records: Array<{ id: string }>) => records.map(record => record.id).sort();
const LearnedMemorySchema = MemorySchema.extend({ evidence: z.array(z.object({
  source_id: z.string(), quote: z.string(), client_id: z.string(), author_role: z.string(), origin: z.string(),
  capture_method: z.string(), occurred_at: z.string().nullable(), recorded_at: z.string(),
})) });
const DetailSchema = z.object({ memory: MemorySchema, sources: z.array(ExportSourceSchema),
  evidence: z.array(EvidenceSchema), revisions: z.array(RevisionSchema) });
export type LearnedDetail = z.infer<typeof DetailSchema>;
type LearnedMemory = z.infer<typeof LearnedMemorySchema>;
function assertSourceChecksum(source: z.infer<typeof ExportSourceSchema>) {
  assert.equal(source.checksum, createHash('sha256').update(source.text, 'utf8').digest('hex'), 'Source checksum must identify the exact original UTF-8 text');
}

const recallRecord = (memory: LearnedMemory) => ({ ...memory, evidence: memory.evidence.map(evidence => ({ ...evidence,
  occurred_at: evidence.occurred_at === null ? null : new Date(evidence.occurred_at).toISOString(),
  recorded_at: new Date(evidence.recorded_at).toISOString(),
})).sort((a, b) => a.source_id.localeCompare(b.source_id) || a.quote.localeCompare(b.quote)) });

/** Retrieval may omit irrelevant records; every returned record must be canonical. */
export function assertLearnedRecall(rawMemories: unknown, rawExpected: unknown, targetId?: string) {
  const memories = z.array(LearnedMemorySchema).parse(rawMemories), expected = z.array(LearnedMemorySchema).parse(rawExpected);
  if (targetId !== undefined) assert.equal(memories[0]?.id, targetId, 'Learned paraphrase should rank its relevant canonical record first');
  assert.equal(new Set(memories.map(memory => memory.id)).size, memories.length, 'Recall returned duplicate records');
  const byId = new Map(expected.map(memory => [memory.id, recallRecord(memory)]));
  assert.equal(byId.size, expected.length);
  for (const memory of memories) {
    assert(byId.has(memory.id), 'Recall returned an unexpected record');
    assert.deepEqual(recallRecord(memory), byId.get(memory.id), 'Recall changed canonical statement, metadata or source evidence');
  }
}

export function learnedRecallRecord(detail: LearnedDetail) {
  return LearnedMemorySchema.parse({ ...detail.memory,
    evidence: detail.evidence.filter(evidence => evidence.revision === detail.memory.revision).map(evidence => {
      const source = detail.sources.find(source => source.id === evidence.source_id);
      assert(source, 'Current evidence omitted its original source');
      return { source_id: source.id, quote: evidence.quote, client_id: source.client_id, author_role: source.author_role,
        origin: source.origin, capture_method: source.capture_method, occurred_at: source.occurred_at, recorded_at: source.recorded_at };
    }),
  });
}

/** Fixed synthetic acceptance, deliberately using the same finite semantic rubric as the corpus. */
export function assertLearnedExtraction(rawMemories: unknown, rawSources: unknown, project: string, clientId: string) {
  const memories = z.array(LearnedMemorySchema).parse(rawMemories);
  const sources = z.array(ExportSourceSchema).parse(rawSources);
  assert.equal(new Set(memories.map(memory => memory.id)).size, 2, 'Expected two distinct learned records');
  assert.equal(sources.length, 2);
  assert.equal(new Set(sources.map(source => source.id)).size, 2);
  assert.deepEqual(sources.map(source => source.event_id).sort(), directLearnedCase.events.map(event => event.id).sort());
  for (const source of sources) {
    assertSourceChecksum(source);
    const event = directLearnedCase.events.find(event => event.id === source.event_id)!;
    assert.equal(source.text, event.text, 'Original source text changed');
    assert.equal(source.client_id, clientId);
    assert.equal(source.project_id, project);
    assert.equal(source.subject, 'self');
    assert.equal(source.author_role, event.author_role);
    assert.equal(source.origin, event.origin);
    assert.equal(source.capture_method, 'explicit_capture');
    assert.equal(source.occurred_at, new Date(event.occurred_at!).toISOString());
    assert.equal(source.extraction_blocked, false);
  }
  const byId = new Map(sources.map(source => [source.id, source]));
  for (const memory of memories) {
    assert.equal(memory.project_id, project);
    assert.equal(memory.subject, 'self');
    assert.equal(memory.revision, 1);
    assert.equal(memory.authoritative, false);
    assert.equal(memory.extractor, model);
    for (const evidence of memory.evidence) {
      const source = byId.get(evidence.source_id);
      assert(source, 'Evidence must reference one of the two captured sources');
      for (const field of ['client_id', 'author_role', 'origin', 'capture_method'] as const) {
        assert.equal(evidence[field], source[field], `Evidence ${field} differs from original source`);
      }
      // PostgreSQL JSON renders offsets differently from the source HTTP mapper.
      for (const field of ['occurred_at', 'recorded_at'] as const) {
        assert.equal(evidence[field] === null ? null : Date.parse(evidence[field]), source[field] === null ? null : Date.parse(source[field]),
          `Evidence ${field} differs from original source`);
      }
    }
  }
  const rubric = evaluateMemoryRubric(directLearnedCase, memories.map(memory => ({ ...memory,
    evidence: memory.evidence.map(evidence => ({ quote: evidence.quote, event_id: byId.get(evidence.source_id)?.event_id })),
  })));
  assert(rubric.rubric_passed, 'Learned deadline/preference must preserve complete source-bound relationships');
  const matched = (eventId: string) => memories[rubric.expectations.find(expected => expected.source_event_id === eventId)!.matched_memory_index!];
  return { deadline: matched('direct-deadline'), preference: matched('direct-preference'), sources };
}

export function assertLearnedDeletionPreview(raw: unknown, preference: unknown, preferenceSource: unknown, deadlineSourceId: string, jobId: string) {
  const preview = DeletionPreviewSchema.parse(raw);
  const memory = MemorySchema.parse(preference), source = ExportSourceSchema.parse(preferenceSource);
  assertSourceChecksum(source);
  preview.sources.forEach(assertSourceChecksum);
  assert.deepEqual(preview.target, { kind: 'memory', id: memory.id });
  assert.equal(preview.expected_revision, memory.revision);
  assert.equal(preview.blast_radius, 'whole_connected_source_events');
  assert.deepEqual(preview.memories, [memory]);
  assert.deepEqual(preview.sources, [source]);
  assert.equal(preview.revision_count, 1);
  assert.equal(preview.evidence_count, 1);
  assert.equal(preview.jobs.length, 1);
  const job = preview.jobs[0];
  assert.equal(job.id, jobId);
  assert.equal(job.status, 'complete');
  assert.deepEqual([...job.source_ids].sort(), [source.id, deadlineSourceId].sort());
  assert.deepEqual(job.affected_source_ids, [source.id]);
  assert.deepEqual(job.source_ids.filter(id => !job.affected_source_ids.includes(id)), [deadlineSourceId],
    'The preview must expose the original deadline source retained after shared job removal');
  return preview;
}

export function assertLearnedDeadlineHistory(raw: unknown, original: LearnedDetail, changed: unknown) {
  const detail = DetailSchema.parse(raw), current = MemorySchema.parse(changed);
  original.sources.forEach(assertSourceChecksum);
  detail.sources.forEach(assertSourceChecksum);
  assert.deepEqual(detail.memory, current);
  assert.equal(current.id, original.memory.id);
  assert.equal(current.project_id, original.memory.project_id);
  assert.equal(current.subject, original.memory.subject);
  assert.equal(current.kind, original.memory.kind);
  assert.equal(current.effective_at, original.memory.effective_at, 'A statement-only correction must preserve the original effective time');
  assert.equal(current.created_at, original.memory.created_at, 'Correction must preserve the original creation time');
  assert(Date.parse(current.updated_at) > Date.parse(original.memory.updated_at), 'Correction must advance the original update time');
  assert.equal(current.origin, 'user_confirmed');
  assert.equal(current.status, 'active');
  assert.equal(current.revision, 2);
  assert.equal(current.authoritative, true);
  assert.equal(current.extractor, null);
  assert.equal(detail.sources.length, 2);
  assert.equal(original.sources.length, 1);
  const previousSource = detail.sources.find(source => source.id === original.sources[0].id);
  assert.deepEqual(previousSource, { ...original.sources[0], extraction_blocked: true }, 'Correction/forgetting changed original source evidence');
  const correction = detail.sources.find(source => source.id !== original.sources[0].id)!;
  assert.equal(correction.text, current.statement);
  assert.equal(correction.capture_method, 'profile_correction');
  assert.equal(correction.author_role, 'user');
  assert.equal(correction.origin, 'user_confirmed');
  assert.equal(correction.client_id, 'profile', 'Correction evidence must be authored by the owner profile');
  assert.equal(correction.event_id, `correction:${current.id}:${current.revision}`, 'Correction evidence must retain its portable revision identity');
  assert.equal(correction.project_id, current.project_id);
  assert.equal(correction.subject, current.subject);
  assert.equal(correction.extraction_blocked, true);
  assert.equal(correction.occurred_at, current.updated_at, 'Correction source occurrence must identify the correction transaction');
  assert.equal(correction.recorded_at, current.updated_at, 'Correction source recording must identify the correction transaction');
  assert.equal(detail.revisions.length, 2);
  assert(detail.revisions.every(revision => revision.memory_id === current.id));
  assert.deepEqual(detail.revisions.find(revision => revision.revision === 1), { ...original.revisions[0], status: 'superseded' });
  const revision = detail.revisions.find(revision => revision.revision === 2)!;
  assert.equal(revision.statement, current.statement);
  assert.equal(revision.origin, 'user_confirmed');
  assert.equal(revision.status, 'active');
  assert.equal(revision.extractor, null);
  assert.equal(revision.effective_at, current.effective_at);
  assert.equal(revision.editor_client_id, 'profile', 'Correction revision must be authored by the owner profile');
  assert.equal(revision.created_at, current.updated_at, 'Correction revision creation must identify the correction transaction');
  assert.deepEqual(detail.evidence, [...original.evidence, { memory_id: current.id, revision: 2, source_id: correction.id, quote: current.statement }]);
  return detail;
}

export function assertLearnedArchiveHistory(raw: unknown, detail: LearnedDetail, forgotten: { memory: unknown; source: unknown }) {
  const archive = ExportSchema.parse(raw);
  archive.sources.forEach(assertSourceChecksum);
  assert.deepEqual(archive.memories, [detail.memory]);
  assert.deepEqual(ids(archive.sources), ids(detail.sources));
  for (const source of detail.sources) assert.deepEqual(archive.sources.find(value => value.id === source.id), source);
  assert.deepEqual(archive.revisions, detail.revisions);
  assert.deepEqual(archive.evidence, detail.evidence);
  const memory = MemorySchema.parse(forgotten.memory), source = ExportSourceSchema.parse(forgotten.source);
  assertSourceChecksum(source);
  // This disposable lifecycle forgets exactly one source and one revision.
  // Check every replay fence, including the scoped interpretation fingerprint.
  const expected = [
    { kind: 'source_identity', hash: sourceIdentity(source.client_id, source.event_id) },
    { kind: 'source_content', hash: sourceContent(source.text) },
    { kind: 'memory_content', hash: memoryContent(memory.statement, memory.project_id, memory.subject) },
  ];
  const fingerprints = (records: Array<{ kind: string; hash: string }>) => records.map(record => `${record.kind}:${record.hash}`).sort();
  assert.deepEqual(fingerprints(archive.tombstones), fingerprints(expected), 'Export must retain exactly the forgotten source and memory replay fences');
  return archive;
}

export function learnedDetail(raw: unknown) {
  const detail = DetailSchema.parse(raw);
  detail.sources.forEach(assertSourceChecksum);
  return detail;
}
