# Threadkeeper handoff

## Current state — 2026-10-03 full-stack milestone

Continued fetched `origin/main` **`3f412ea`**, including merged PR #1, on
`codex/self-hosted-stack`. Read AGENTS.md, README.md, MVP_BRIEF.md, DECISIONS.md,
HANDOFF.md, CODEX_CLOUD.md and RETRIEVAL.md and inspected the implementation before
editing. The pinned baseline passed before feature work: Node **24.19.0**, pnpm
**11.25.0**, all **44 tests**, typecheck/profile build and both `pnpm demo` paths.
The ambient pnpm was 11.19.0; the existing task-local Corepack shim recipe selected
11.25.0 without changing pins or reusable Cloud environment settings.

`pnpm integration` now builds and runs the complete application in a disposable
Compose project: native PostgreSQL/pgvector, API serving the built React profile,
actual worker and a deterministic OpenAI-compatible **synthetic HTTP fixture**.
See [requirements, command and evidence boundaries](INTEGRATION.md). The fixture
is explicitly selected only by the test overlay, and every extraction request
retains `nvidia/Nemotron-3_5-Lightning`. No configured memory model is substituted.

### Defects fixed

- The application image's Node 24.7.0 `fetch` ignored a custom Host header, causing
  the original Compose API healthcheck to return 403 and block the worker. The
  healthcheck now uses `node:http` and preserves the configured Host. The harness
  selects an available localhost API port and uses that exact external origin.
- Networked Docker build steps now accept an optional `proxy_ca` BuildKit secret
  for managed proxy trust. TLS verification stays enabled; the CA and operator
  `.env` files are absent from image layers.
- Extraction previously accepted an explicit different response model while
  reporting the configured model. Chat responses now reject mismatched and
  malformed identities; compatible endpoints may still omit the optional field.
- An old extraction attempt could overwrite a reclaimed job's status/result.
  Claims now return the current attempt counter, and admission and terminal
  updates are fenced by that counter. Regressions cover older success and failure
  while the newer attempt remains in flight.
- Harness diagnosis fixed the SQL aggregation's collision with the jobs `result`
  column. Failed runs report the stage and sanitized SQL diagnostics. Ambient
  `THREADKEEPER_INTEGRATION_*` settings cannot override disposable generated
  settings. Signals cancel active scenarios and preserve cleanup operations.

### Commands and observed results

```sh
mkdir -p /tmp/threadkeeper-bin
corepack enable --install-directory /tmp/threadkeeper-bin pnpm
PATH=/tmp/threadkeeper-bin:$PATH corepack install
PATH=/tmp/threadkeeper-bin:$PATH pnpm install --frozen-lockfile
PATH=/tmp/threadkeeper-bin:$PATH pnpm check
PATH=/tmp/threadkeeper-bin:$PATH pnpm demo
PATH=/tmp/threadkeeper-bin:$PATH pnpm integration
git diff --check
```

| Evidence | Actual result |
| --- | --- |
| Credential-free baseline after fixes | `pnpm check` passed **51/51 tests**, typecheck and profile production build; both `pnpm demo` lifecycles/export-import passed. PGlite/fixture results, independent of Docker/provider secrets. |
| Standard application Compose | Disposable build/startup passed native DB readiness, API health, built profile HTTP 200, generated owner sign-in and worker startup. No queued extraction/provider call in this smoke. |
| Full application + synthetic HTTP provider | **All 9 scenario stages passed** using separately authenticated MCP SDK clients, profile HTTP writes, actual worker process and native canonical records. |
| Native regression command within the application image | `THREADKEEPER_NATIVE_TEST_URL="$DATABASE_URL" node --import tsx --test tests/hybrid.test.ts tests/api-hybrid.test.ts` passed **15/15**. Fourteen vector-enabled cases used isolated native schemas; the no-extension fallback intentionally used PGlite. |
| Native setup | Application migrations applied at startup and `pnpm migrate` reran successfully after the lifecycle. |
| Cleanup | Successful and failed harness runs removed their project containers, networks, named database volumes, generated app images and private temp credentials. Label checks verify no project resources remain. Shared pulled base images/build cache may remain. |
| Cancellation | Sending `kill -TERM <runner-pid>` during the active worker lifecycle made the runner exit **1** and verify complete resource/credential cleanup. A separate held MCP request probe confirmed client cancellation settles immediately (3 ms observed). |
| Real-provider/GPU execution in this task | **Not run.** Runtime status lists no configured secrets/provider variables/identities; no operator `.env` exists. No `nvidia-smi` or GPU device is available. This limits learned-model/embedding and GPU validation, not the independently completed full-stack work. |

Observed runtime versions: host Node **24.19.0**, application image Node
**24.7.0**, host/image pnpm **11.25.0**, Docker **28.4.0**, Compose **2.40.3**,
PostgreSQL **17.11 (Debian 17.11-1.pgdg12+2)**, pgvector **0.8.7**. The first
complete passing application image was
`sha256:ac4f14d75abe0bb792d1df92d8042f1c78ea273f6d2f958c1f0d3fd4f981ea08`.
Database image `pgvector/pgvector:pg17` resolved to
`sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`;
Node base `node:24.7.0-bookworm-slim` resolved to
`sha256:0104d9447ea3ddf7373643be7f9915fc7b7c896e41d0d33229338e457217cd78`.
The integration command prints its own application ID/database digest per run.
The final code rerun again passed all nine stages and the native 15-test command,
using application image
`sha256:c64c8c3a0e895d3d3a0c53e9468835792ceb41849ce9bbf46da73c3e12c66551`.

Client A captured deadline/preference source events **without explicit memories**.
The worker's real HTTP adapter extracted two active statements plus a separately
labeled inference candidate, then indexed three-dimensional synthetic vectors.
Client B recalled both using `milestones and prose style`, which native SQL
verified had no lexical match. Profile correction/deletion made fresh retrieval
from both clients contain only the corrected authoritative deadline; deleted
source, derived inference and export content disappeared.

Further stages passed owner/project/source/client isolation, capture/read denial,
revocation before provider invocation, lexical fallback and recovery for HTTP
failure/wrong model/wrong dimensions, durable failed extraction without accepted
output, and correction/deletion while extraction and embedding replies were held.
The fixture received no Authorization header and saw only the intended model IDs
and dimension. These are synthetic integration assertions, not model-quality
measurements. Historical real Nemotron/Qwen observations below remain separate.

### Remaining limitations

Real-provider worker execution, learned embedding retrieval quality, local GPU
feature parity, installed ChatGPT/Codex host behavior, sustained load, operational
backup/restore and public release remain unverified. Extraction attempt fencing
is now implemented; embedding work still has no durable attempt/retry ledger.
Existing exact ranking, conservative whole-source deletion and reconciliation
limits still apply. OSS license remains undecided. No merge, deployment, DNS,
paid provisioning or reusable Cloud settings change occurred.

## Earlier hybrid recall increment — 2026-10-03

Continued the private `ThomsenDrake/threadkeeper` repository from fetched `origin/main` commit `5ef67d5` on branch `codex/hybrid-recall`. Read AGENTS.md, README.md, MVP_BRIEF.md, DECISIONS.md, this handoff and CODEX_CLOUD.md, then inspected the provider, database, worker and API implementation before changing behavior. Threadkeeper remains a portable personal-context service for existing clients. No deployment, DNS change, paid provisioning or public release occurred.

Optional hybrid recall is now connected to the existing OpenAI-compatible provider adapter and PostgreSQL memory layer. Full-text/substring retrieval remains the default without embedding configuration. The API, worker and `pnpm reindex` accept configurable hosted or keyless self-hosted embedding endpoints and require explicit runtime dimensions. See [retrieval setup and limits](RETRIEVAL.md).

Both rankers consume one owner/project/subject/source/status-filtered set of canonical memories. Exact cosine and lexical ranks are merged with reciprocal-rank fusion; no ANN index is created. Results retain current-revision evidence, attribution, inference/candidate labels and correction authority. Embeddings are identified by endpoint, model, dimension and preprocessing version. Database triggers invalidate them on corrections/status changes, and deletion cascades. Worker admission rechecks current state under the owner lock after the provider call, preventing stale in-flight output from restoring corrected or deleted vectors. Imports preserve canonical evidence/history and rebuild embeddings.

## Baseline diagnosis and verification

The Cloud environment ran Node.js **24.19.0** but initially resolved a fallback **pnpm 11.19.0**, despite the repository pin **11.25.0**. The first `pnpm check` and `pnpm demo` passed (22 tests, typecheck, build and original lifecycle). There were no baseline application failures.

`corepack enable pnpm` failed with EACCES because the system Node directory was not writable. A task-local shim resolved the mismatch without changing the repository pin:

```sh
mkdir -p /tmp/threadkeeper-bin
corepack enable --install-directory /tmp/threadkeeper-bin pnpm
PATH=/tmp/threadkeeper-bin:$PATH corepack install
PATH=/tmp/threadkeeper-bin:$PATH pnpm install --frozen-lockfile
PATH=/tmp/threadkeeper-bin:$PATH pnpm check
PATH=/tmp/threadkeeper-bin:$PATH pnpm demo
```

All baseline commands then passed with pnpm **11.25.0**, before feature work. The reusable Cloud Install script/environment configuration was not edited or republished. The runtime network policy is restricted; no provider credentials were configured or required.

## Actual final results

| Check | Observed result |
| --- | --- |
| Frozen dependency install | Passed with pnpm 11.25.0; added pinned `@electric-sql/pglite-pgvector@0.0.9` matching PGlite 0.5.8 |
| `pnpm check` | Passed typechecking, **44 tests**, and Vite production build; 0 failed/skipped |
| `pnpm demo` | Passed both credential-free full-text and synthetic hybrid lifecycles, each with fresh-database export/import |
| Synthetic hybrid tests | **13/13 passed** with PGlite pgvector; covers paraphrases, rank fusion/limit/dedup, all scopes/filters, evidence/inference distinctions, fallback, space changes, corrections/deletions, in-flight indexing races, import rebuild and 4096 dimensions |
| Authenticated hybrid HTTP/MCP | **2/2 passed** using independent SDK clients; nonlexical recall, profile correction/deletion before/after reindex, owner/project/read/capture enforcement and revocation |
| Provider tests | **16/16 passed**, included in the 44 total; dimensions forwarded/validated, key isolation, keyless endpoint, invalid/zero/float32 geometry and large valid batches |
| Browser regression | Passed on Chromium **151.0.7922.173**, disposable PGlite and lexical default; sign-in, capture, all filters/search, provenance, correction/deletion, independent scoped HTTP client, export/import, revocation, mobile overflow and sign-out. No browser runtime exceptions. [Evidence](measurements/hybrid-ui-qa.json) |
| Review/whitespace | Independent correctness review found no remaining actionable code defect; stale current-state documentation was corrected. `git diff --check` passed |

The central demonstration remains: Client A captures separate deadline/preference source events; Client B recalls both; the owner corrects the deadline and deletes the preference; fresh recall from both clients returns only the corrected deadline. Hybrid tests also assert that stale/deleted vectors disappear immediately, lexical recall exposes the correction before reindexing, and semantic recall exposes it after reindexing. Shared-source inference records are deleted with their supporting preference.

The browser run exercised the unchanged profile UI against the updated API using lexical retrieval. It did not exercise vectors in the browser or perform a new screenshot visual review. SDK transport tests are not installed ChatGPT/Codex host integrations.

## Native PostgreSQL/pgvector checks

These checks **ran successfully**, separately from PGlite. Docker's managed local daemon was available. A disposable localhost-only `pgvector/pgvector:pg17` container ran PostgreSQL **17.11** and pgvector **0.8.7**. Image digest:

```text
sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d
```

- Existing and new migrations applied successfully, including rerunning the new setup.
- The hybrid test command passed **13/13**: 12 vector-enabled cases used native PostgreSQL; the explicit no-extension fallback intentionally remained PGlite.
- Both new HTTP/MCP tests passed against native PostgreSQL (**2/2**).
- `pnpm demo` with `THREADKEEPER_NATIVE_TEST_URL` passed native hybrid lifecycle/export/import; its full-text half intentionally remained the credential-free PGlite baseline.
- The actual environment-driven `deploy/reindex.ts` CLI worked with native storage and a temporary localhost OpenAI-compatible HTTP fixture through the real adapter: first run indexed 1 synthetic memory, identical rerun indexed 0, changed model alias rebuilt 1, and hybrid recall returned the expected source-backed preference. Requests supplied the configured model/dimension and omitted Authorization for the keyless endpoint. This was synthetic HTTP validation, not learned-model inference.
- Exact vector storage/cosine succeeded at **3, 2000, 2001, 4096 and 16000** dimensions. Both HNSW and IVFFlat `vector_cosine_ops` indexes succeeded through 2000 and rejected 2001/4096/16000 with SQLSTATE `54000`. `vector(16001)` rejected with `22023`.
- Native inspection found finite float32 vectors could still produce NaN cosine scores through norm overflow/underflow. Stable unit normalization and a finite similarity gate fixed this; extreme-vector and legacy-invalid-score regressions passed.

Native tests use explicit `THREADKEEPER_NATIVE_TEST_URL`, require pgvector installed in `public`, and create/drop isolated synthetic schemas. Never use an operator/production database. The disposable database container, temporary HTTP fixture, synthetic rows, browser and profile service were stopped/removed after checks. No persistent test service remains.

**Native checks not run:** full Threadkeeper application image build/Compose API+worker startup, production upgrade/rollback/backup-restore, sustained load/ANN benchmarks and non-container/native-host packaging. These were not blocked by a missing database; they remain separate validation scope. No learned local/GPU embedding or inference server, real external-provider hybrid retrieval, or installed MCP host was tested in this task.

## Remaining limits and next work

- Exact vector ranking scans eligible rows; no large-archive latency/throughput measurement or ANN index selection is claimed. The cosine threshold 0.3 and RRF parameters are initial heuristics.
- Synthetic geometry proves integration and lifecycle behavior, not semantic quality. Measure the chosen provider's dimensions, preprocessing/instruction prefixes, recall quality, token usage and latency before selecting it for real data. The implementation sends raw statement/query text and stores unit vectors.
- Indexing is eventual. Corrected content is immediately searchable lexically and semantically searchable after reindex. Coverage says whether the query path ran, not whether all eligible records have been indexed.
- One configured vector space is stored per memory. Keep API/worker/reindex settings aligned and stop workers with old settings before switching. Use versioned model aliases when changing server weights; a changed model behind an identical alias is undetectable. Restart after extension/schema changes because capability checks are cached.
- Embedding workers have no durable per-record retry ledger or attempt leases. Multiple workers can duplicate provider work; a malformed batch can block later indexing until corrected. Transactional admission still prevents stale/deleted writes. Provider failure leaves full-text recall available.
- Revocation blocks subsequent requests; an already-authorized request waiting for its embedding provider retains its permission snapshot. Previously delivered client context and provider-retained copies are outside active-store deletion.
- Model reconciliation rejects invalid evidence and exact obsolete statements; paraphrase conflict/dedup/reinstatement remains incomplete. Inference/proposal review and contradiction workflows remain limited.
- Deletion intentionally removes whole connected source events and sibling memories. Span-level preservation and an affected-record preview remain future work. No summaries/retrieval cache are generated in this slice.
- Backup restore deletion reconciliation, a migration ledger, rollback/recovery procedures, extraction attempt fencing and job retry/status endpoints remain unfinished. See [portability](PORTABILITY.md).
- Full self-hosted GPU inference/embedding feature parity and installed chatbot/coding-agent integrations remain release gates. No hosted account, feature gate, license check or telemetry requirement was added.
- OSS license remains undecided; choose one before public release. A previously reported GitGuardian notification has not been resolved by this work; original hardcoded localhost DB fallbacks were removed on main, but their historical incident details were not retrieved.

Next increment should measure real embedding preprocessing/quality with synthetic data, validate the full application containers and actual installed MCP hosts, then address operational retry/restore gaps. Preserve explicit client-invoked capture/recall, authoritative profile corrections and deletion behavior. Rerun the checks/demo and relevant native/browser tests after behavioral changes; record results instead of treating configuration as proof.

## Review follow-up — 2026-10-03

The requested GitHub `@codex review` of `88ac4d4` completed with no findings. A parallel local review found that the embedding adapter discarded an explicit response model identity and always reported the configured model. Same-dimensional vectors from a detectably different model could therefore enter the configured space.

The adapter now rejects an explicit different model (`embedding_model_mismatch`) and malformed identities before accepting vectors. Matching identities and endpoints that omit the optional field remain supported. Two regressions exercise substitution, recovery, omission and malformed values. `pnpm check` passed all **44 tests**, typechecking and build, and `pnpm demo` passed both full-text and hybrid lifecycle/export-import paths after this fix. These updates are submitted for another GitHub Codex review. Native database and browser checks above belong to the original hybrid commit; they were not rerun for this provider-response validation change.

## Earlier evidence retained

Prior live synthetic Nemotron/embedding observations are recorded in [PROVIDER_VERIFICATION.md](PROVIDER_VERIFICATION.md) and [nebius-extraction.json](measurements/nebius-extraction.json). They established the exact Nemotron ID, JSON-object output, a no-side-effect tool call, two source-backed extraction records and a 4096-dimensional Qwen response through the developer's authenticated integration. They are historical evidence, not new API-key worker or hybrid-quality checks from this Cloud task. Earlier Chromium 153 visual screenshots remain in [ui-qa.json](measurements/ui-qa.json); the new browser regression evidence is separate.
