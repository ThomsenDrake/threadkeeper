export const extractionCanonicalVersion: 'threadkeeper-extraction-v1';
export type ExtractionFingerprints = { canonical_version: typeof extractionCanonicalVersion;
  input_sha256: string; memory_count: number; memories_sha256: string };
export function extractionRecordsFingerprint(records: unknown, context: unknown): ExtractionFingerprints | undefined;
export function extractionResponseFingerprint(request: unknown, response: unknown): ExtractionFingerprints | undefined;
