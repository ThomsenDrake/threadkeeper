# Installed OpenCode learned lifecycle

This optional development check runs the published Linux x64 OpenCode **1.18.34** binary against a disposable Threadkeeper API and in-memory PGlite database. It is explicitly stacked on PR #16. The normal dependency baseline does not install OpenCode. Native PostgreSQL/pgvector has a separate measured checkpoint at `28a83b8`; local GPU parity, other host families and public deployment remain release gates.

The source-bound launcher creates a private archive of an exact clean commit, installs its locked dependencies offline using Node 24 and pnpm 11.25.0, copies and verifies the published host binary, and executes only archived code. Dependency preparation and version checks receive no provider credentials. The application and hosts call Nebius directly at `https://api.tokenfactory.nebius.com/v1/` using `nvidia/Nemotron-3_5-Lightning`; there is no Executor or request relay.

The four fresh host phases are:

1. Under an explicit capture prompt, host A chooses `context_capture` for two exact, separate synthetic source events. Explicit memories are forbidden; the receipt must be pending with no memory IDs.
2. The canonical Threadkeeper worker runs in process on PGlite and extracts the deadline and preference. Host B chooses `context_search` and receives both canonical records, without receiving A's transcript or answer values in its prompt.
3. The owner corrects the deadline through profile HTTP operations and confirms the preference's deletion preview. A fresh A session chooses recall and receives the corrected current state.
4. A fresh B session independently chooses recall and receives the same current state.

Actual MCP requests and JSON/SSE responses are paired by phase, client and RPC ID. Text and structured tool results must agree. Returned memory statements, revisions and provenance must match independently fetched canonical records. Worker response fingerprints bind the stored extraction to the final parsed direct response. Correction history, deleted source/job IDs and export tombstones are checked using the existing native-lifecycle assertions. This measures model-selected tool use under explicit phase instructions and canonical full-text retrieval; it does not establish unprompted capture or score final natural-language answers or broad extraction accuracy.

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

Credential-free local sentinel checks of the published host established exact chat request fields, bearer-authenticated MCP tool execution, fifth-attempt denial across retries and tool loops, malformed-request denial and keyless plugin failure. Those synthetic responses do not establish learned tool selection. The actual live result is recorded below separately from those fixtures.


## Recorded live result

One authorized run completed at **2026-10-03 21:38:39.545 UTC**, without a retry, on immutable source **`c46ee6e76e11cccbf1b3a84bd7aa5eee46a801cb`** (tree `4a89dda8dd9f3aa80c7b06cc4d6e113e1568165a`). The [raw artifact](measurements/opencode-learned-host.json) is preserved byte-for-byte: **68,157 bytes**, SHA-256 **`e808605efc0c15650a0c726ebae644d176b1f84ee1b4d87574976077ad76a88e`**. Its 211 source-file hashes were independently verified against that commit and the working tree at measurement time. Node **24.7.0**, pnpm **11.25.0**, the pinned OpenCode binary above and `NODE_USE_ENV_PROXY=1` were used.

| Phase | Direct chat requests | Actual MCP calls | Reported total tokens |
| --- | ---: | ---: | ---: |
| Capture A | 2 | 1 capture | 4,651 |
| Canonical extraction | 1 | — | 1,724 |
| Independent recall B | 3 | 2 searches | 5,759 |
| Fresh recall A after owner changes | 3 | 2 searches | 4,574 |
| Fresh recall B after owner changes | 3 | 2 searches | 4,590 |
| Total | **12** | **7** | **21,298** |

All requests returned HTTP 200 and the exact model; usage reconciled to **19,874 prompt + 1,424 completion tokens**, with **zero reported reasoning tokens** and **zero embeddings**. All 11 host response streams had complete usage, `[DONE]` and clean EOF. Every host completed with a fresh session; there were no guard denials, provider failures or MCP observation failures. The original two records matched the final parsed extraction response. Owner correction changed the deadline from October 20 to October 27, 2026, at authoritative revision 2; forgetting removed the preference, its source and extraction job. Both fresh clients retrieved only that corrected canonical record. All recorded cleanup checks passed, the launcher exited and independent inspection found no private run directories remaining.

Implementation **`7921e9390002715bfe4ab7719bde2c8e0e0ab5ef`** passed **188/188 tests**, typechecking, build and both synthetic demo paths before the documentation-only `c46ee6e` live checkpoint. The later integration of checked PR #16 candidate **`144dcbf742c5142684fc1af1fbaa6429f3198fa3`** preserves this measurement's original source attribution; its native-harness fixes do not turn this PGlite run into native-container evidence. Application provider code, OpenCode guards and host runtime code remain unchanged by that integration. Integrated runtime `25ed7b57d95fcf3733f2c037af69ed87862e3a01` passed typechecking, 10/10 pure guard tests and 26/26 targeted host/native-helper tests under the same Node/pnpm versions. These credential-free checks did not rerun the full suite or live evaluation.

[PR #18](https://github.com/ThomsenDrake/threadkeeper/pull/18) remains stacked on PR #16. GitHub Codex review is unavailable because of the usage limit recorded in [comment 5973680013](https://github.com/ThomsenDrake/threadkeeper/pull/15#issuecomment-5973680013); local review and measurements do not authorize self-merge. After prerequisite merges, integrate actual main, retarget, obtain review of the resulting final head and merge only with the required checks and expected-head guard. GPU parity, broader extraction quality, other host-family behavior and deployment/publication/license decisions remain separate gates.
