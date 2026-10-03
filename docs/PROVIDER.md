# Model provider contract

The worker calls the configured OpenAI-compatible HTTP endpoint directly. It does not require Executor or an OpenAI account. The default request model is `nvidia/Nemotron-3_5-Lightning` at `https://api.tokenfactory.nebius.com/v1/`. A configured local alias uses the same adapter. No automatic model substitution occurs.

The extractor receives only the authorized source events in one capture job. It produces candidates with one exact source quote each. Shared Zod schemas check the shape; code checks source IDs, exact quotations, subject, and direct-user attribution. Agent reports remain agent reports, assistant proposals cannot become direct user statements, and the model cannot invent user confirmation. Database code owns authorization, corrections, revisions, and deletion. Exact quote validation establishes the quoted text exists; semantic support still requires evaluation.

Extraction has at most two requests: one attempt and one repair. The default requests `json_object` and validates locally. Set `MODEL_JSON_OBJECT=false` for prompt-only local endpoints. Strict JSON schema is an optional capability via `MODEL_STRUCTURED_OUTPUT=true`. A rejected format or invalid output receives one prompt-only repair using the same model. Truncated output is rejected. Reasoning control is omitted by default; the bounded synthetic Nebius evaluations explicitly select `MODEL_REASONING_EFFORT=none`.

One narrow completeness check rejects an omitted `effective_at` with sanitized code `extraction_missing_effective_timestamp`, using that same bounded repair. It applies only to direct-user or user-confirmed attribution when the quote is the entire source, begins with `Starting` or `Effective` followed by `at` or `from` and one full timezone-bearing timestamp, and its remaining simple positive assertion exactly matches the statement after trimming and removing one final period. It never assigns the timestamp itself. Compound or multiple-sentence text, paraphrases, partial quotes, date-only starts, deadlines, assistant/inferred attribution and detected ambiguity remain outside this guard. Passing it is not a general semantic-support check. [Verification](PROVIDER_VERIFICATION.md#literal-effective-time-completeness--2026-10-03) separates controlled repair tests from the one-case live observation.

| Variable | Default or behavior |
| --- | --- |
| `MODEL_BASE_URL` | Nebius `/v1/` base URL above |
| `MODEL_ID` | Exact Lightning ID above; configurable local alias |
| `MODEL_API_KEY` | Optional; omitted from keyless local requests |
| `NEBIUS_API_KEY` | Fallback only for the official Nebius hostname |
| `MODEL_TIMEOUT_MS` | 60000 per request; maximum 300000 |
| `MODEL_MAX_OUTPUT_TOKENS` | 4096; maximum 32768 |
| `MODEL_REASONING_EFFORT` | Omitted by default; optional `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` sent on initial and repair requests |
| `MODEL_JSON_OBJECT` | Enabled unless `false` |
| `MODEL_STRUCTURED_OUTPUT` | Disabled unless `true` |
| `MODEL_MAX_EVENTS` | 32; upper bound 32 |
| `MODEL_MAX_SOURCE_CHARACTERS` | 64000; upper bound 64000 |
| `EMBEDDING_MODEL` | Unset; embeddings disabled |
| `EMBEDDING_BASE_URL` | Same as model endpoint unless supplied |
| `EMBEDDING_API_KEY` | Optional; falls back to the model key only for the same normalized endpoint |
| `EMBEDDING_TIMEOUT_MS` | 60000 per request; maximum 300000 |
| `EMBEDDING_DIMENSIONS` | Required for runtime hybrid recall (1–16000), sent to the provider and checked against every response; optional for the standalone probe |
| `WORKER_POLL_MS` | 1000; 100 to 60000 allowed |

The embedding adapter validates finite float32, nonzero vectors, response indices and consistent dimensions. When the endpoint supplies a response model identity, it must exactly match the configured alias; explicit substitutions and malformed identities are rejected. Endpoints may omit that optional response field. Runtime storage normalizes vectors to unit length for stable cosine ranking. It creates no fallback or fabricated vectors. [Hybrid retrieval](RETRIEVAL.md) is optional; failed query embeddings fall back to full-text with a coverage reason. Raw statement/query text is sent to the configured provider without model-specific instruction prefixes. Synthetic tests establish integration and lifecycle behavior, not embedding quality or correct preprocessing for every model. Local inference hardware and runtime compatibility require a separate real deployment test.

Run `pnpm provider:check` with operator-configured secrets to measure model listing, chat, a validation-only tool call, JSON output, source-backed extraction, and optional embeddings. Set `PROVIDER_CHECK_SCHEMA=true` for an additional strict-schema probe. The script sends synthetic data, does not execute the proposed tool, and prints only capability checks, timing, usage, and sanitized error codes. Its output describes that run only. It does not claim full self-hosting, quality superiority, or a deployment.

The targeted provider unit tests use mocked HTTP responses. They verify invalid-evidence rejection, bounded repair, fixed model selection, role/origin distinctions, usage accumulation, vector validation, dimension drift, and key separation. They are not live inference checks.
