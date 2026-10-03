import { createHash } from 'node:crypto';

// Optional synthetic-acceptance evidence only. These helpers never retain raw
// inputs or vectors and are usable by the plain Node fetch preload.
export const embeddingPreprocessingVersion = 'raw-statement-unit-v1';
export const embeddingInputFingerprint = text => createHash('sha256').update(text).digest('hex');

/** Hash actual stored components, without normalizing them a second time. */
export function storedVectorFingerprint(vector, dimensions) {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16000
    || !Array.isArray(vector) || vector.length !== dimensions) return undefined;
  const bytes = Buffer.alloc(dimensions * 4);
  let nonzero = false;
  for (let index = 0; index < dimensions; index++) {
    const value = vector[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const component = Math.fround(value);
    if (!Number.isFinite(component) || (value !== 0 && component === 0)) return undefined;
    nonzero ||= component !== 0;
    // JSON insertion into pgvector turns -0 into 0; canonicalize both sources.
    bytes.writeFloatLE(component === 0 ? 0 : component, index * 4);
  }
  return nonzero ? createHash('sha256').update(bytes).digest('hex') : undefined;
}

/** Bind a complete indexed response to the inputs actually sent by fetch. */
export function embeddingResponseFingerprints(request, response) {
  if (!Array.isArray(request?.input) || request.input.length < 1 || request.input.length > 64
    || request.input.some(text => typeof text !== 'string' || !text || text.length > 16000)
    || !Array.isArray(response?.data) || response.data.length !== request.input.length) return undefined;
  const ordered = response.data.slice().sort((a, b) => a?.index - b?.index);
  if (ordered.some((row, index) => !row || row.index !== index || !Array.isArray(row.embedding))) return undefined;
  const dimensions = ordered[0].embedding.length;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16000
    || (request.dimensions !== undefined && request.dimensions !== dimensions)
    || ordered.some(row => row.embedding.length !== dimensions)) return undefined;
  const entries = [];
  for (const [index, row] of ordered.entries()) {
    // Independently reproduce provider float32 conversion then the documented
    // core scale-safe unit normalization, followed by pgvector float32 storage.
    if (!storedVectorFingerprint(row.embedding, dimensions)) return undefined;
    const values = row.embedding.map(value => Math.fround(value));
    const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    const norm = Math.sqrt(values.reduce((sum, value) => sum + (value / scale) ** 2, 0));
    const normalized = values.map(value => Math.fround((value / scale) / norm));
    const stored = storedVectorFingerprint(normalized, dimensions);
    if (!stored) return undefined;
    entries.push({ index, input_sha256: embeddingInputFingerprint(request.input[index]), stored_vector_sha256: stored });
  }
  return { preprocessing_version: embeddingPreprocessingVersion, dimensions, entries };
}
