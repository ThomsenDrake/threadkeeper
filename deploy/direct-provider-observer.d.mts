export type NumericTokenUsage = { [key: string]: number | NumericTokenUsage };
export type ProviderObservation = {
  event: 'direct_provider_request'; ordinal: number; path: string; method: string;
  started_at: string; sent: boolean; elapsed_ms: number;
  outcome: 'http_response' | 'network_error' | 'budget_exhausted';
  usage_status: 'reported' | 'absent' | 'unreadable' | 'not_sent';
  requested_model?: string; returned_model?: string; returned_model_matches?: boolean;
  request_sha256?: string; response_sha256?: string; input_count?: number; http_status?: number;
  finish_reason?: string; usage?: NumericTokenUsage;
  embedding_fingerprints?: import('./embedding-fingerprints.mjs').EmbeddingFingerprints;
};
export function numericTokenUsage(value: unknown): NumericTokenUsage | undefined;
export function summarizeProviderObservations(records: ProviderObservation[]): {
  observed_attempt_count: number; direct_request_count: number; inference_request_count: number;
  usage_complete: boolean; inference_requests_without_usage: number; inference_requests_without_complete_usage: number; derived_total_tokens_request_count: number; usage: NumericTokenUsage;
};
export type ProviderObserverOptions = {
  baseUrl?: string; baseUrls?: string[]; models?: string[]; limits?: Partial<Record<'models' | 'chat/completions' | 'embeddings', number>>;
  onRecord?: (record: ProviderObservation) => void;
  embeddingFingerprints?: boolean;
};
export function providerObservationConfigFromEnv(env?: NodeJS.ProcessEnv): ProviderObserverOptions;
export function installDirectProviderObserver(options?: ProviderObserverOptions): { records: ProviderObservation[]; errors: string[]; restore(): void };
