export type OpenCodeGuardRecord = {
  event: 'opencode_guard_ready' | 'opencode_guard_failed' | 'opencode_provider_denied' | 'opencode_provider_request' | 'opencode_provider_result';
  ordinal?: number; sent?: boolean; code?: string; config_invocations?: number;
  provider?: string; request_limit?: number; max_output_tokens?: number;
  requested_model?: string; reasoning_effort?: 'none'; max_tokens?: number; stream?: boolean;
  message_count?: number; tool_names?: string[]; started_at?: string;
  outcome?: 'network_error' | 'http_response'; http_status?: number; elapsed_ms?: number;
  usage_status?: 'reported' | 'absent' | 'unreadable'; usage?: import('./direct-provider-observer.mjs').NumericTokenUsage;
  usage_invalid?: true; usage_complete?: boolean; returned_model_matches?: boolean; done_seen?: boolean;
  stream_status?: 'complete' | 'cancelled' | 'read_error' | 'non_sse' | 'absent';
};
export type OpenCodeGuardConfig = {
  enabled_providers?: string[];
  provider?: Record<string, { npm?: string; env?: string[]; apiKey?: string;
    options?: { baseURL?: string; apiKey?: string; fetch?: typeof globalThis.fetch; [key: string]: unknown } }>;
};
type Hook = { config(config: OpenCodeGuardConfig): void };
export const OpenCodeProviderGuard: (() => Promise<Hook>) & {
  createForTest(options: { apiKey: string; logPath: string; originalFetch: typeof globalThis.fetch }): Hook & { close(): void; block(): void };
};
