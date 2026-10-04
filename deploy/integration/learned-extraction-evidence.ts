import assert from 'node:assert/strict';
import { z } from 'zod';
import { MemorySchema, ExportSourceSchema } from '../../packages/contracts/src/index.ts';
import { extractionRecordsFingerprint, type ExtractionFingerprints } from '../extraction-fingerprints.mjs';
import type { LearnedObservation } from './learned-support.ts';

export function snapshotLearnedExtraction(rawMemories: unknown, rawSources: unknown, context: { project_id: string | null; subject: string }) {
  const memories = z.array(MemorySchema.extend({ evidence: z.array(z.object({ source_id: z.string(), quote: z.string() })).length(1) })).max(64).parse(rawMemories);
  const sources = z.array(ExportSourceSchema).max(32).parse(rawSources);
  const byId = new Map(sources.map(source => [source.id, source]));
  assert.equal(byId.size, sources.length, 'Extraction evidence contains duplicate source identities');
  const records = memories.map(memory => {
    assert.equal(memory.revision, 1, 'Extraction evidence must precede correction');
    assert.equal(memory.extractor, 'nvidia/Nemotron-3_5-Lightning', 'Extraction model differs');
    const source = byId.get(memory.evidence[0].source_id);
    assert(source, 'Extraction evidence references an unknown source');
    return { project_id: memory.project_id, subject: memory.subject, statement: memory.statement, kind: memory.kind,
      origin: memory.origin, status: memory.status, effective_at: memory.effective_at,
      source_event_id: source.event_id, quote: memory.evidence[0].quote };
  });
  const fingerprint = extractionRecordsFingerprint(records, { ...context, events: sources.map(source => ({
    id: source.event_id, text: source.text, author_role: source.author_role, origin: source.origin,
    occurred_at: source.occurred_at, client_id: source.client_id,
  })) });
  assert(fingerprint, 'Persisted extraction cannot be fingerprinted');
  return fingerprint;
}

/** Match the final attempt, retaining repairs as separately observed attempts. */
export function verifyLearnedExtractionEvidence(evidence: unknown, observations: LearnedObservation[]) {
  const snapshot = evidence as ExtractionFingerprints | undefined;
  assert(snapshot && snapshot.canonical_version === 'threadkeeper-extraction-v1', 'Missing canonical extraction evidence');
  assert.match(snapshot.input_sha256, /^[0-9a-f]{64}$/, 'Invalid extraction input fingerprint');
  assert.match(snapshot.memories_sha256, /^[0-9a-f]{64}$/, 'Invalid extracted memory fingerprint');
  assert(Number.isSafeInteger(snapshot.memory_count) && snapshot.memory_count >= 0 && snapshot.memory_count <= 64, 'Invalid extracted memory count');
  const attempts = observations.filter(item => item.service === 'worker' && item.path === 'chat/completions');
  assert(attempts.length >= 1 && attempts.length <= 2, 'Expected bounded worker extraction attempts');
  const final = attempts.reduce((last, item) => item.ordinal > last.ordinal ? item : last);
  assert(final.sent && final.http_status === 200 && final.returned_model_matches === true
    && final.requested_model === 'nvidia/Nemotron-3_5-Lightning', 'Final worker extraction request did not succeed');
  assert.deepEqual(final.extraction_fingerprints, snapshot, 'Persisted extraction differs from the final direct provider response');
  return { ordinal: final.ordinal, memory_count: snapshot.memory_count };
}
