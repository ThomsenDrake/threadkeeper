# Provider verification

Date: 2026-10-02 UTC. Live observations below were reported by the parent development session from authenticated synthetic checks. No credentials or private transcript content belong in this document. Rerun `pnpm provider:check` with an operator-managed secret before deployment.

## Live observations

| Check | Observed result | Conclusion |
| --- | --- | --- |
| Authenticated model list | Exact `nvidia/Nemotron-3_5-Lightning` present | Available to the tested account at that time |
| JSON-schema trial, `max_tokens:150` | Returned thinking text, `finish_reason:length`; 51 prompt + 150 completion = 201 total tokens | Truncated and unusable as structured extraction. This does not establish whether schema enforcement works with an adequate budget |
| JSON-object trial, `max_tokens:1200` | HTTP 200, `finish_reason:stop`, valid content `{"ok":true,"deadline":"2026-10-20"}`; 52 prompt + 459 completion = 511 total, including 436 reported reasoning tokens | Minimal inference and JSON-object output succeeded; no broader extraction quality claim |
| Embedding model listing | `BAAI/bge-en-icl` absent; `Qwen/Qwen3-Embedding-8B` available | Do not silently call an unavailable embedding model |
| Synthetic Qwen embedding | HTTP 200, 4,096 finite dimensions, 16 reported input/total tokens | Embedding endpoint works for this request; retrieval quality and preprocessing still need evaluation |
| No-side-effect Nemotron tool request | HTTP 200, expected tool call and deadline arguments; 314 prompt + 62 completion = 376 total tokens | Minimal tool selection/arguments succeeded; no external action executed |
| First extraction prompt | Model returned an invalid date-only `effective_at` | Validation rejected it. A deadline date is not an effective timestamp |
| Revised extraction prompt | Two valid source-backed records with null `effective_at`; 769 prompt + 2,068 completion = 2,837 total, including 1,928 reported reasoning tokens | Minimal deadline/preference extraction succeeded after clarifying effective-time rules |
| Application validation/worker replay | Recorded live response passed the shared provider validator, then PostgreSQL worker replay accepted 2 records and skipped 0 | Measured inference and application validation were exercised separately. This was not a direct application API-key worker call |

Broader extraction quality, latency distribution and fully local inference remain separate checks. The minimal tool/extraction requests above are not proof of a robust memory agent. Update this table with actual test evidence as those checks run. The embedding adapter and optional database table do not yet implement semantic retrieval; recall uses PostgreSQL full-text search.

The authenticated live inference transport was the developer's Executor integration using an application-generated synthetic request. The application itself has its own configurable HTTP provider and does not depend on Executor. The recorded extraction evidence is [measurements/nebius-extraction.json](measurements/nebius-extraction.json).

## Documented provider contract

- Base URL: `https://api.tokenfactory.nebius.com/v1/`; bearer secret `NEBIUS_API_KEY`.
- Chat: `POST /chat/completions`. The selected model remains configurable, with exact Nemotron ID as the Nebius default.
- Model listing: `GET /models`; optional `ai_project_id` and `verbose` parameters.
- Tools: the API returns proposed calls, not executed actions. The current application uses bounded JSON extraction and no runtime tool loop; only a no-side-effect tool selection probe was exercised.
- JSON support is model-specific. The structured-output guide illustrates `json_schema`; the chat API reference currently describes `json_object` and `text`. Use measured behavior and local validation to resolve that documentation conflict.
- Embedding vectors include their model/preprocessing identity. Validate finite values and dimensions before storage. No ANN index is created for an unverified shape.

Qwen's official embedding card describes query instructions separately from plain retrieval documents, last-token pooling and normalization. Its 8B model supports MRL dimensions from 32 to 4,096. A smaller requested dimension is a useful future compatibility experiment; Nebius's exact dimension/preprocessing behavior still needs a live check before changing this deployment's vector space.

## Reasoning control

NVIDIA's local vLLM recipe documents `chat_template_kwargs: { enable_thinking: false }` passed through an OpenAI SDK's `extra_body`. SDK extra-body parameters are commonly flattened into the HTTP payload. This establishes a local-server control, not a verified Nebius control. Nebius's current API reference lists generic extra parameters but does not document this specific flag. Do not add it to the hosted default without a successful endpoint test.

## Self-hosted deployment contract

**Required and not yet demonstrated.** The API, profile, authentication, database, jobs and provider adapters are being packaged locally. GPU inference and local embedding setup still need an actual hardware run and the central demonstration using those providers.

NVIDIA publishes `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` and BF16 checkpoints with vLLM image `vllm/vllm-openai:v0.27.1`. Local serving names differ from the Nebius alias; set `MODEL_ID` to the identifier returned by the local `/v1/models`. Tool parsing uses `qwen3_coder`, with reasoning parser `nemotron_v3`. Pin the final runtime digest and checkpoint revision after testing. Model downloads are an initial setup requirement; steady-state local operation must not depend on provider accounts.

For the smallest end-to-end loop, connect `MODEL_BASE_URL` and embedding configuration to operator-run compatible servers. This is configurable infrastructure, not proof that a particular GPU works. Do not advertise a minimum hardware specification before measuring it.

## Primary sources inspected

- [Nebius model identifier](https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice)
- [Nebius quickstart](https://docs.tokenfactory.nebius.com/quickstart)
- [Chat API reference](https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion)
- [Structured output guide](https://docs.tokenfactory.nebius.com/ai-models-inference/json)
- [Tool calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling)
- [Model listing](https://docs.tokenfactory.nebius.com/api-reference/models/list-models)
- [Embedding API](https://docs.tokenfactory.nebius.com/api-reference/inference/create-embeddings)
- [NVIDIA local recipes](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4)
- [pgvector index limits](https://github.com/pgvector/pgvector)
- [BGE preprocessing](https://huggingface.co/BAAI/bge-en-icl)
- [Qwen embedding dimensions and preprocessing](https://huggingface.co/Qwen/Qwen3-Embedding-8B)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP HTTP handler](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)
- [MCP protocol compatibility](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)

Documentation describes published capabilities. Authenticated observations describe the tested account and request. Neither implies a deployed Threadkeeper service.
