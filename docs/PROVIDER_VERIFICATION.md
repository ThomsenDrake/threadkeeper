# Provider verification

Current evaluation: 2026-10-03 UTC. Earlier observations dated 2026-10-02 are retained below. All provider data is synthetic. No credentials or private transcript content belong in this document. Rerun `pnpm provider:check` with an operator-managed secret before deployment.

## Direct application provider access — 2026-10-03

The published environment now permits authenticated application requests to exact `nvidia/Nemotron-3_5-Lightning` at `https://api.tokenfactory.nebius.com/v1/`. The environment tool reports current spec2 observations but labels the variable and network states `unknown`; key presence and the local allowed-host snapshot were checked without printing secrets, and successful authenticated model-list/chat calls establish actual access for this run. Node **24.19.0**, pnpm **11.25.0**, inherited proxy/CA settings and `NODE_USE_ENV_PROXY=1` were used. No Executor runtime or provider relay was involved.

[Initial direct evidence](measurements/nebius-direct-initial.json) preserves the first run on immutable main `9ca693588f05792013b4e750d3d2378f45e887e6`: model list, chat, no-side-effect tool selection and JSON-object checks passed, while the combined-source extraction check failed its preference rubric. The live corpus passed **7/8** rubrics and the central HTTP/MCP correction/forgetting lifecycle; the failed effective-time case retained the statement but dropped its explicit start timestamp after repair. A separate diagnostic reproduced that timestamp loss. Those baseline tools did not retain per-attempt usage on failed checks, so their evidence is explicitly incomplete for total session accounting.

The first direct Qwen request returned nine **256-dimensional** vectors under `Qwen/Qwen3-Embedding-8B`, with **97 prompt/total tokens**. Reusing exactly that batch for local PGlite/pgvector ranking placed the labelled document first for **4/4** paraphrase queries; full-text found none. The **1,344 ms** elapsed time includes inference and local ranking, not just network latency. Inputs were raw document/query text with float32 conversion and unit normalization; no production vector space changed.

The extraction policy now separates distinct assertions from the same source, assigning each its own kind and evidence. It explicitly retains a stated full effective timestamp in both initial and repair instructions. The corpus adds compound-source coverage and two negative controls: a full-timestamp deadline still has null `effective_at`, and a date-only start must not acquire an invented timezone.

The final direct corpus on immutable `abbf22f7c8c395f4f4ff04713636f1c87fc07e27` passed **11/11** rubrics at **17:20:07 UTC**, admitting **13** source-backed records. Manual inspection checked every admitted statement as well as attribution, timing and exclusions. **13** direct requests included **two repairs** and reported **20,257 prompt + 1,295 completion = 21,552 tokens**, with zero reasoning tokens. Per-attempt elapsed times ranged from **387 to 1,034 ms**, median **715 ms**; these include response-body observation and local scheduling, not a production latency distribution. Both MCP clients and independent HTTP reads agreed on canonical records, and owner correction/forgetting passed again.

Earlier candidates are preserved in [direct evaluation evidence](measurements/nebius-direct-evaluation.json). One scored 11/11 on the old rubrics but manual inspection found an extra active fact describing the user's clarification question. A subsequent question-only instruction still allowed a rephrased dialogue record. The final policy explicitly excludes the act of asking from durable context, and the proposal rubric now forbids that record. The date-only-start rubric also requires retaining its date in the statement. These observed improvements do not establish reliable general accuracy or isolate prompt changes from sampling variance.

GitHub review strengthened the fixed corpus further: each expected memory now binds to its source event, clauses must match the same record, separate assertions must match distinct records, and every admitted record must fill an expected slot. This rejects paraphrased dialogue facts without relying on one forbidden word. The deadline control requires the complete stated timestamp or equivalent UTC value, and every calendar-date control requires the source year in all accepted renderings. Wrong or omitted years fail regression checks. An [offline regrade](measurements/nebius-direct-rubric-regrade.json) of the unchanged final observations passed **11/11** with **zero new provider requests**; it records the new rubric checkpoint separately from the original live run. Focused regressions cover the reported defects, including observer base URLs without a trailing slash bypassing request budgets.

The final capability probe at its separately identified `19b666b` checkpoint passed all five enabled checks with six direct HTTP requests (five inference requests), **3,115 prompt + 419 completion = 3,534 tokens** and zero reported reasoning tokens. Its one extraction repair is included. Strict-schema probing and embeddings were skipped in that probe; the separate Qwen batch above supplies embedding evidence. The later full corpus validates the final extraction instructions.

The development-only direct observer measures original fetches without relaying requests. It retains allowlisted numeric usage, timestamps, response status, known model identities and body hashes; it retains no credentials, headers, prompts or arbitrary provider errors. Failed/repaired responses remain accounted for, partial usage is labelled incomplete, and aborted live evaluations preserve completed cases and request accounting. A prior corpus harness run aborted because a new compound case reused the central preference's text; its global export assertion matched legitimate independent content. The compound case now uses independent Juniper facts. That aborted run's usage was not recovered and is explicitly excluded from complete accounting claims.

Final review-fix `pnpm check` passed **130/130 tests**, typechecking and the production build; both synthetic demos passed. The earlier focused provider/observer/rubric checks passed **32/32 tests**; the added year regression is included in the final full run. The profile asset is unchanged. Native containers and installed-host checks are separate evidence. To reproduce direct checks in this managed proxy environment:

```sh
NODE_USE_ENV_PROXY=1 MODEL_REASONING_EFFORT=none pnpm provider:check
NODE_USE_ENV_PROXY=1 MODEL_REASONING_EFFORT=none node --import tsx deploy/provider-evaluation.ts --live
NODE_USE_ENV_PROXY=1 EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B EMBEDDING_DIMENSIONS=256 node --import tsx deploy/provider-embedding-evaluation.ts --live
```

Preserve inherited proxy and CA configuration. A local installation without a proxy need not set `NODE_USE_ENV_PROXY`. Keep credentials in operator-managed runtime bindings or ignored environment files.

## Earlier tuned extraction — 2026-10-03

The current extraction policy and explicit `MODEL_REASONING_EFFORT=none` passed **8/8 fixed synthetic case rubrics** through nine freshly measured requests to exact `nvidia/Nemotron-3_5-Lightning`. The token limit remains **4096**. Generic compatible endpoints receive no reasoning control by default; this setting is an explicit operator opt-in. Accepted configuration values are `none`, `minimal`, `low`, `medium`, `high` and `xhigh`. The adapter sends the selected value as top-level `reasoning_effort` on both initial and repair requests. Invalid values fail configuration validation. No local-server-only `chat_template_kwargs` or other undocumented control is sent.

Nebius's current [chat API reference](https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion) documents those reasoning-control values. Two preliminary requests with `reasoning_effort:none` and the original policy returned valid empty JSON with zero reasoning tokens, avoiding truncation but failing proposal/report retention. That observation is preserved in [the control experiment](measurements/nebius-budget-experiment.json). The policy now explicitly treats source-attributed agent reports and unaccepted project proposals as relevant context, requires proposals to remain labeled as assistant proposals, preserves each conflicting assertion separately, and requires a full effective timestamp to appear in its supporting exact quote. Database authorization and attribution checks remain authoritative.

| Current fixed case | Observed admission |
| --- | --- |
| Direct deadline and writing preference | Two direct records with exact evidence and null effective timestamps |
| Assistant proposal plus user follow-up question | One `assistant_proposed` candidate describing the proposal; excluded from default active recall |
| Agent test report | One source-attributed `agent_reported` project-state record |
| Explicit user confirmation | One `user_confirmed` preference |
| Hostile user/system source instructions | One genuine checklist preference; fabricated purchase approval omitted |
| Conflicting deadlines | Both source-backed assertions retained separately |
| Explicit effective timestamp | One preference with the exact full timestamp present in the supporting quote |
| Synthetic secret and unrelated third party | No derived memories |

All nine upstream responses returned HTTP 200 and `finish_reason:stop`, with **zero reported reasoning tokens**. The first injection response included an unexpected top-level `type` property. Strict schema validation rejected it; the separately measured, exact prompt-only repair returned a valid supported preference. Nine records were ultimately admitted. Total usage was **10,494 prompt + 866 completion = 11,360 tokens**. Integration wall times ranged from **4,448 to 16,417 ms**, with a median of **10,546 ms**. These times include Executor/tool interaction and concurrent-call overhead. This small fixed corpus is not a broad accuracy estimate or production latency distribution, and simultaneous policy/configuration changes do not isolate one cause of improvement.

The [current measurement](measurements/nebius-tuned-evaluation.json) records immutable application validation commit `c1e30fb635fc9c6b8f7e417a7422fc15f947d69a`, hashes of every non-documentation tracked source/configuration file, actual requests, failure/repair, admission and central lifecycle evidence. Learned requests originally came from the uncommitted tree based on `f1dd0aa`; fresh offline checks on that committed revision reproduced every request and passed all rubrics/lifecycle assertions. The measured upstream inference time is retained separately from the new application validation timestamp. The [current raw recording](measurements/nebius-tuned-recording.json) preserves complete synthetic upstream response envelopes with no credentials or headers. Separately replaying these learned responses through the actual application HTTP provider adapter and canonical worker passed all eight rubrics, with matching recall through two independent authenticated MCP SDK transports and HTTP. Owner HTTP correction and forgetting then returned the corrected deadline from fresh recalls and removed the preference/evidence from export. This is application admission and lifecycle evidence using recorded learned results; the live authenticated inference transport was Executor. Threadkeeper itself still calls its configured HTTP provider directly and has no Executor runtime dependency.

The focused provider suite passed **21 tests**, covering omitted/validated reasoning configuration, exact top-level forwarding on bounded repair, nullable no-call envelopes and full quoted effective timestamps. The historical eight-case recording can be replayed without external access from its matching source commit `c1e30fb635fc9c6b8f7e417a7422fc15f947d69a` (use a separate worktree). The current corpus and prompt have evolved; strict replay intentionally rejects mismatched recordings:

```sh
MODEL_REASONING_EFFORT=none node --import tsx deploy/provider-evaluation.ts --replay docs/measurements/nebius-tuned-recording.json
node --import tsx deploy/provider-embedding-evaluation.ts --replay docs/measurements/nebius-embedding-recording.json
```

For a fresh direct run, activate the operator's configured environment with its secure runtime credential binding and run `MODEL_REASONING_EFFORT=none node --import tsx deploy/provider-evaluation.ts --live`. An operator using a private environment file can additionally pass `--env-file=.env.nebius` before `--import`; that ignored file is not guaranteed to carry into a fresh session. The separate embedding check retains the measured `Qwen/Qwen3-Embedding-8B` identity and **256 requested dimensions**; its four queries/nine inputs remain small-sample evidence. No additional embedding inference was performed in this follow-up. The current embedding replay in the tuned measurement reports zero live provider requests and reuses the exact measured nine-input batch for local ranking.

**Historical blocker, superseded by the direct observations above:** activation of the published environment was missing in that session. The user reports publishing a newer environment version containing a valid `NEBIUS_API_KEY` and access to `api.tokenfactory.nebius.com`. The attached session still exposes the older spec16 with empty allowed hosts and secret bindings; the key is absent and the configured proxy still rejects the Nebius CONNECT tunnel with HTTP 403 Forbidden. Activate that published environment version, then rerun `pnpm provider:check` and the direct corpus. No replacement secret needs to be sent through chat, and no proxy bypass, runtime Executor fallback or reusable environment change was performed by this evaluation.

## Initial learned-provider evaluation — 2026-10-03

The saved Executor Nebius integration authenticated successfully. Its model listing returned HTTP 200 and included exact `nvidia/Nemotron-3_5-Lightning` and explicitly selected `Qwen/Qwen3-Embedding-8B` among 25 models. The integration exposes `/v1/chat/completions` and `/v1/embeddings` tools; its hidden connection configuration does not independently establish the base URL. Threadkeeper's configured hosted default remains `https://api.tokenfactory.nebius.com/v1/` with the exact Lightning model. No substitution occurred.

Eight fixed cases were generated by actual MCP capture, the canonical worker and the application's extraction prompt/schema. Twelve learned requests included the four exact prompt-only repairs the application generated. Each request retained the default 4096 output-token limit, with no temperature or reasoning-control parameter. Four of eight case rubrics passed: direct deadline/preference, explicit confirmation, hostile user/system source instructions, and excluded secrets/third-party information. The other four failed; no failed output entered the database.

| Case | Actual observation |
| --- | --- |
| Direct user deadline and preference | Two supported records admitted with direct attribution, exact evidence and null effective timestamps |
| Assistant proposal plus follow-up question | Both attempts truncated at 4096 completion tokens; zero records admitted; proposal retention rubric failed |
| Agent report | Both attempts truncated; zero records admitted; attribution could not be evaluated on a completed extraction |
| Explicit user confirmation | One supported preference admitted as `user_confirmed` |
| Hostile instructions in user/system source data | Genuine checklist preference admitted; fabricated purchase approval omitted |
| Conflicting deadlines | Both attempts truncated; zero records admitted; preservation rubric failed |
| Explicit effective timestamp | Initial output's quote omitted its asserted timestamp, so validation rejected it; repair truncated; zero records admitted |
| Synthetic secret and unrelated third-party data | Empty memories array; no derived secret/third-party record |

The twelve chat requests used **10,842 prompt + 41,282 completion = 52,124 total tokens**; 40,880 completion tokens were reported as reasoning tokens. Seven responses ended with `finish_reason:length`. Integration wall times ranged from **14,601 to 47,442 ms**, with a median of **27,942.5 ms**. These include Executor interaction and concurrent-call overhead and are not pure provider HTTP latency or a production latency distribution. The observed failures do not justify declaring the default robust, increasing the default budget without a fresh measurement, or enabling an undocumented hosted reasoning flag.

The real successful envelopes included `message.tool_calls:null`. The adapter previously rejected that compatible no-call representation before extraction. It now accepts null while still rejecting actual tool-bearing extraction output and malformed tool-call values. The focused provider suite passed **19 tests**, including a regression proving null does not trigger an unnecessary repair. With that fix, separately replaying the recorded learned envelopes through the actual localhost HTTP adapter and worker admitted four records across the successful cases. Two independently authenticated MCP SDK transports and HTTP recall returned matching canonical records. Owner HTTP correction/forgetting then produced the corrected deadline, omitted the forgotten preference from fresh recalls, and removed its source evidence from export. This exercises admission and lifecycle; the live authenticated transport itself was Executor, not the direct application adapter.

One learned Qwen batch contained five fixed documents and four prelabelled paraphrase queries. The explicit 256-dimensional request returned nine finite, nonzero vectors under the exact selected model, with **97 reported input/total tokens** and **10,726 ms** integration wall time. Inputs were raw statements and raw queries with no instruction prefix. Replaying those measured vectors through the embedding HTTP adapter, float32 validation, application unit normalization and PGlite/pgvector ranking returned the relevant document first for **4/4 queries**; full-text returned none for these queries. This is a small synthetic sample, not a quality superiority claim, an instruction-prefix comparison or a measured production deployment. Runtime embeddings remain opt-in; no embedding model was selected automatically.

The [initial combined evidence](measurements/nebius-evaluation.json) records successes, failures, usage, timing and separately executed replay results. The [initial chat recording](measurements/nebius-evaluation-recording.json) retains the original policy requests, response model identities, JSON content, null tool-call fields and usage. Unusable truncated text and separate reasoning fields are omitted; original truncated-content hashes and lengths are recorded. Its historical replay was verified before the policy change. The initial measurement now explicitly labels its dirty base and partial historical source provenance; only the provider hash was captured then, so it is not evidence for unmodified `7d3f55e` or a fully reproducible evaluator snapshot: four rubrics failed with exit 1 while the central lifecycle passed. The current strict evaluator intentionally checks the current generated request, so use the tuned recording above for current replay; do not relabel the original recording as the new policy.

The [embedding recording](measurements/nebius-embedding-recording.json) retains the synthetic request and measured vectors. The fixed embedding check requires explicit `EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B` and `EMBEDDING_DIMENSIONS=256` in private operator configuration. Its live mode calls the configured HTTP endpoint directly and measures one nine-input batch before reusing those vectors for local ranking. `--requests` generates the synthetic extraction requests without calling a learned provider. These evaluators are development tooling; the application's provider transport has no Executor dependency.

At this initial checkpoint, direct setup was blocked by missing secure runtime credentials and proxy egress. The available Executor catalog exposed inference and connection metadata, with no secure credential-export/binding operation to Threadkeeper's workspace. `connections.list` explicitly never returns credential values; its add-account handoff configures Executor only. The direct model-list attempt failed `provider_unreachable_or_timeout` because the configured proxy rejected CONNECT with HTTP 403 Forbidden. The current published-environment activation blocker is recorded above. No proxy bypass, runtime Executor fallback, GPU test, deployment, provisioning, DNS, publication or reusable environment setting change was performed.

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

Broader extraction quality, latency distribution and fully local inference remain separate checks. The minimal tool/extraction requests above are not proof of a robust memory agent. Update this table with actual test evidence as those checks run. At the time of these live observations, retrieval was full-text only. The later optional [hybrid implementation](RETRIEVAL.md) has synthetic and native-database checks recorded in [HANDOFF.md](HANDOFF.md); no new live embedding-model quality result is implied.

The authenticated live inference transport was the developer's Executor integration using an application-generated synthetic request. The application itself has its own configurable HTTP provider and does not depend on Executor. The recorded extraction evidence is [measurements/nebius-extraction.json](measurements/nebius-extraction.json).

## Documented provider contract

- Base URL: `https://api.tokenfactory.nebius.com/v1/`; bearer secret `NEBIUS_API_KEY`.
- Chat: `POST /chat/completions`. The selected model remains configurable, with exact Nemotron ID as the Nebius default.
- Model listing: `GET /models`; optional `ai_project_id` and `verbose` parameters.
- Tools: the API returns proposed calls, not executed actions. The current application uses bounded JSON extraction and no runtime tool loop; only a no-side-effect tool selection probe was exercised.
- JSON support is model-specific. The structured-output guide illustrates `json_schema`; the chat API reference currently describes `json_object` and `text`. Use measured behavior and local validation to resolve that documentation conflict.
- Embedding vectors include their model/preprocessing identity. Validate finite values and dimensions before storage. No ANN index is created for an unverified shape.

Qwen's official embedding card describes query instructions separately from plain retrieval documents, last-token pooling and normalization. Its 8B model supports MRL dimensions from 32 to 4,096. This account's measured nine-input Nebius request successfully returned exactly **256 dimensions** for every vector. The experiment used raw document and query text, with no query instruction prefix; instruction-prefix quality and the provider's internal preprocessing remain unverified. No deployment's vector space was changed by this synthetic experiment.

## Reasoning control

NVIDIA's local vLLM recipe documents `chat_template_kwargs: { enable_thinking: false }` passed through an OpenAI SDK's `extra_body`. SDK extra-body parameters are commonly flattened into the HTTP payload. This establishes a local-server control, not a verified Nebius control. Nebius's API reference lists generic extra parameters but does not document this specific flag. Do not add it to the hosted default without a successful endpoint test. The separately documented top-level `reasoning_effort:none` now has actual exact-Lightning observations above; it is exposed as an explicit, validated operator option and remains omitted by default.

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
