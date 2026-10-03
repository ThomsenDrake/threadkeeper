# Installed OpenCode learned lifecycle

This optional development check runs the published Linux x64 OpenCode **1.18.34** binary against a disposable Threadkeeper API and in-memory PGlite database. It is explicitly stacked on PR #16. The normal dependency baseline does not install OpenCode. Native PostgreSQL/pgvector, local GPU parity, other host families and public deployment remain separate gates.

The source-bound launcher creates a private archive of an exact clean commit, installs its locked dependencies offline using Node 24 and pnpm 11.25.0, copies and verifies the published host binary, and executes only archived code. Dependency preparation and version checks receive no provider credentials. The application and hosts call Nebius directly at `https://api.tokenfactory.nebius.com/v1/` using `nvidia/Nemotron-3_5-Lightning`; there is no Executor or request relay.

The four fresh host phases are:

1. Host A chooses `context_capture` for two exact, separate synthetic source events. Explicit memories are forbidden; the receipt must be pending with no memory IDs.
2. The canonical Threadkeeper worker extracts the deadline and preference. Host B chooses `context_search` and receives both canonical records, without receiving A's transcript or answer values in its prompt.
3. The owner corrects the deadline through profile HTTP operations and confirms the preference's deletion preview. A fresh A session chooses recall and receives the corrected current state.
4. A fresh B session independently chooses recall and receives the same current state.

Actual MCP requests and JSON/SSE responses are paired by phase, client and RPC ID. Text and structured tool results must agree. Returned memory statements, revisions and provenance must match independently fetched canonical records. Worker response fingerprints bind the stored extraction to the final parsed direct response. Correction history, deleted source/job IDs and export tombstones are checked using the existing native-lifecycle assertions. This measures model-selected tool use and canonical retrieval; it does not score final natural-language answers or broad extraction accuracy.

The private provider plugin supplies a credential only together with its original-fetch guard. It allows at most **four chat attempts per host phase**, including background calls and retries, with `reasoning_effort: none` and at most **1,024 requested output tokens**. Four phases plus at most two worker attempts means **18 chat requests maximum**, with worker output capped at **4,096 tokens** and **zero embeddings**. Guarded responses must have complete, consistent streamed usage, the exact returned model, `[DONE]` and clean EOF. A denied request or incomplete response fails acceptance. OpenCode's `agent.steps` is advisory; the fetch counter and 120-second phase timeout enforce the bound.

Only the phase's capture or search tool is exposed to the model. Built-in tools, subagents, automatic titles, compaction, updates, default plugins, external skills and project configuration are disabled. XDG paths, OpenCode test home, npm configuration/cache and temporary files are private; `HOME` is preserved. The provider guard rejects redirects and conflicting token caps. It is process instrumentation, not an operating-system network firewall.

Install the optional published packages only in a disposable directory with the pinned toolchain:

```sh
pnpm add --ignore-scripts --save-exact opencode-ai@1.18.34 opencode-linux-x64@1.18.34
```

The verified Linux binary SHA-256 is `9ca0b9953d49997601655e54f846a3efa464f237e47c6f1b04716d0f2e64c4c2`. The launcher enforces this digest and version. Keep its path outside the repository and supply an unused evidence destination. A live run requires the operator-provided `NEBIUS_API_KEY` and the explicit live option:

```sh
NODE_USE_ENV_PROXY=1 node deploy/opencode-run.mjs --source-ref FULL_COMMIT_SHA \
  --binary /tmp/threadkeeper-opencode-check/install/node_modules/opencode-linux-x64/bin/opencode \
  --output /tmp/threadkeeper-direct/opencode-live.json --live
```

Reserve the output before paid requests. Successful evidence is published only after resource cleanup and verification of the archived source and output bytes. Failed acceptance emits sanitized failed observations to stdout and exits nonzero; it does not publish a PASS artifact. Capture the command's stdout/stderr to a private log when running a bounded evaluation. Credentials, host histories, temporary configuration, API and database state are removed afterward.

Credential-free local sentinel checks of the published host established exact chat request fields, bearer-authenticated MCP tool execution, fifth-attempt denial across retries and tool loops, malformed-request denial and keyless plugin failure. Those synthetic responses do not establish learned tool selection. Live results, immutable source attribution and review status belong in HANDOFF and the measurement artifact after an authorized run.
