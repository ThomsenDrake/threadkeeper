export const embeddingPreprocessingVersion: 'raw-statement-unit-v1';
export type EmbeddingFingerprints = {
  preprocessing_version: typeof embeddingPreprocessingVersion; dimensions: number;
  entries: Array<{ index: number; input_sha256: string; stored_vector_sha256: string }>;
};
export function embeddingInputFingerprint(text: string): string;
export function storedVectorFingerprint(vector: unknown, dimensions: number): string | undefined;
export function embeddingResponseFingerprints(request: unknown, response: unknown): EmbeddingFingerprints | undefined;
