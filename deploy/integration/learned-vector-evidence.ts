import assert from 'node:assert/strict';
import { embeddingInputFingerprint, embeddingPreprocessingVersion, storedVectorFingerprint } from '../embedding-fingerprints.mjs';
import type { LearnedObservation } from './learned-support.ts';

export type LearnedVectorSnapshot = {
  memory_id: string; revision: number; model: string; dimensions: number;
  preprocessing_version: typeof embeddingPreprocessingVersion;
  input_sha256: string; stored_vector_sha256: string;
};

/** Raw SQL vectors stay transient; acceptance artifacts contain only hashes. */
export function snapshotLearnedVector(row: unknown, expected: {
  memory_id: string; revision: number; statement: string; model: string; dimensions: number;
}): LearnedVectorSnapshot {
  assert(row && typeof row === 'object', 'Expected one persisted learned vector');
  const value = row as Record<string, unknown>;
  assert.equal(value.memory_id, expected.memory_id, 'Persisted vector belongs to another memory');
  assert.equal(value.revision, expected.revision, 'Persisted vector revision is stale');
  assert.equal(value.provider_model, expected.model, 'Persisted vector model differs');
  assert.equal(value.dimensions, expected.dimensions, 'Persisted vector dimensions differ');
  assert.equal(value.preprocessing_version, embeddingPreprocessingVersion, 'Persisted vector preprocessing differs');
  assert(typeof value.embedding === 'string' && value.embedding.length < 512_000, 'Persisted vector is not bounded text');
  let vector: unknown;
  try { vector = JSON.parse(value.embedding); } catch { assert.fail('Persisted vector is not valid JSON'); }
  const fingerprint = storedVectorFingerprint(vector, expected.dimensions);
  assert(fingerprint, 'Persisted vector components are invalid');
  assert(expected.statement.length > 0 && expected.statement.length <= 16000, 'Expected vector input is outside bounds');
  return { memory_id: expected.memory_id, revision: expected.revision, model: expected.model, dimensions: expected.dimensions,
    preprocessing_version: embeddingPreprocessingVersion, input_sha256: embeddingInputFingerprint(expected.statement), stored_vector_sha256: fingerprint };
}

/** Prove both persisted revisions match their own direct worker input/result. */
export function verifyLearnedVectorEvidence(evidence: unknown, observations: LearnedObservation[]) {
  assert(evidence && typeof evidence === 'object', 'Missing learned vector evidence');
  const snapshots = evidence as { original: LearnedVectorSnapshot; corrected: LearnedVectorSnapshot };
  function match(snapshot: LearnedVectorSnapshot) {
    assert(snapshot && typeof snapshot === 'object', 'Missing learned vector snapshot');
    assert.match(snapshot.input_sha256, /^[0-9a-f]{64}$/, 'Invalid vector input fingerprint');
    assert.match(snapshot.stored_vector_sha256, /^[0-9a-f]{64}$/, 'Invalid stored vector fingerprint');
    const matches = observations.filter(item => item.service === 'worker' && item.path === 'embeddings'
      && item.sent && item.http_status === 200 && item.returned_model_matches === true && item.requested_model === snapshot.model)
      .flatMap(item => {
        const fingerprints = item.embedding_fingerprints;
        if (!fingerprints || fingerprints.preprocessing_version !== snapshot.preprocessing_version || fingerprints.dimensions !== snapshot.dimensions) return [];
        return fingerprints.entries.filter(entry => entry.input_sha256 === snapshot.input_sha256)
          .map(entry => ({ ordinal: item.ordinal, index: entry.index, fingerprint: entry.stored_vector_sha256 }));
      });
    assert.equal(matches.length, 1, 'Expected one worker result for each exact revision statement');
    assert.equal(matches[0].fingerprint, snapshot.stored_vector_sha256, 'Persisted vector does not match its direct provider result');
    return { ordinal: matches[0].ordinal, index: matches[0].index };
  }
  const original = match(snapshots.original), corrected = match(snapshots.corrected);
  assert.equal(snapshots.original.memory_id, snapshots.corrected.memory_id, 'Vector snapshots refer to different memories');
  assert.equal(snapshots.corrected.revision, snapshots.original.revision + 1, 'Corrected vector revision did not advance');
  assert(corrected.ordinal > original.ordinal, 'Corrected vector did not use a subsequent worker response');
  return { original, corrected,
    normalized_vector_changed: snapshots.original.stored_vector_sha256 !== snapshots.corrected.stored_vector_sha256 };
}
