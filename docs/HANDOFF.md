# Threadkeeper handoff


## Current delivery state — 2026-10-03

Candidate review [PR #5](https://github.com/ThomsenDrake/threadkeeper/pull/5) merged into main `487e4d47193cef00d2478db2498f5426a6381e36`. GitHub Codex reviewed final head `e73661ed0cb6b6869dd0d6418ae8a8d4c2649670` with no new findings after the legacy import fix, GitGuardian reported success, and the coordinating session checked the review, verification and merge conditions before merging.

Priority 3 client connection/control development is implemented and verified on `codex/client-control`, now rebased onto that merged main. The rebase skipped the already merged import fix and retained an identical product/test/evidence tree to the final tested branch `d2408ba`; only this delivery status and the development plan changed afterward. Its final checks remain **80/80 tests**, typecheck/build, both demos, **11 native full-stack stages**, migration rerun and **37 native-enabled regression checks**, plus the recorded browser/independent-SDK walkthrough. No broad, native or browser checks were repeated for this unchanged product tree. Its own final-head GitHub review and merge are the next delivery checkpoint. Priority 4 deletion preview/source forgetting is implemented on an explicitly stacked branch, with combined verification recorded below. Priority 3 still requires its own final-head review/merge before the stack can be retargeted to main.

## Predictable forgetting — 2026-10-03

Priority 4 is implemented in the isolated `codex/forgetting-preview` worktree based on main `26c025d`, pending integration with candidate review/client controls and the final GitHub review loop. Memory and source evidence views load the complete forgetting impact before enabling confirmation. Source-only pending/processing captures can be forgotten. Both owner HTTP deletion routes require a current semantic preview hash; memory deletion also checks its revision. The shared graph covers every revision/evidence link, scoped matching assertion histories, connected siblings and known normalized raw-source copies across projects. Only unrestricted owner access can preview or delete this graph.

Confirmation recomputes the graph under the owner lock before any tombstones or deletions. The hash binds the owner and target and includes source/current-memory content, all history/evidence and intersecting job source membership. Unrelated owner updates or transient job progress do not invalidate an unchanged impact. Changed impact requires explicit preview refresh and another confirmation. Every intersecting extraction job is removed in full; other sources in those jobs remain evidence but are not automatically requeued. Current vectors, revisions and evidence cascade away, and in-flight workers cannot restore them. Owner corrections also check source-content tombstones so forgotten source-only content cannot be recreated under a new correction identity.

Observed checks in this isolated branch: `pnpm check` passed **75/75 tests**, TypeScript checks and profile production build, including focused forgetting core **10/10** and owner HTTP **1/1**. Both `pnpm demo` full-text/hybrid lifecycle and fresh export/import paths passed with preview-guarded deletion. Independent local core/API review found the correction replay gap described above; its reproducer now rejects with HTTP 410 and preserves the pre-attempt data. Final integration with candidate review/client controls and native/full-stack checks remain pending; these isolated checks are not a native PostgreSQL or learned-provider claim.

Disposable Chromium **151.0.7922.173** browser QA passed **10 checks** with zero runtime exceptions against a real API and PGlite synthetic fixture. It exercised sibling/history preview, unchanged-target concurrent expansion/HTTP 409, explicit refresh and reconfirmation, queued-source forgetting, removal of mixed-source jobs while retaining independent evidence, held-worker fencing, delayed retry/poll responses, failed follow-up fetches, preview retry, and closing/signing out during delayed preview. The 390px view had no horizontal overflow; desktop/mobile screenshots were visually reviewed. [Browser evidence](measurements/forgetting-ui-qa.json) describes its isolated-branch scope. No learned model, installed MCP host, deployment, backup restore or native database was exercised by this browser run. The disposable fixture was stopped.

Known limits: graph construction reads the owner's source/memory/history/evidence rows to compare normalized source and assertion content; large-archive latency is unmeasured. Exact normalized copies are removed, but semantic paraphrase detection remains incomplete. Retained exports, old backups, provider copies and previously delivered client context remain separate copies. Deletion-aware restore remains priority 6.

## Candidate review development — 2026-10-03

Capture recovery [PR #4](https://github.com/ThomsenDrake/threadkeeper/pull/4) merged as main `26c025d` after GitHub Codex reviewed exact head `0744ca387a`, found no major issues, and remote Devin Review reported success. No review threads, required approvals or merge conflicts remained; merge used an expected-head SHA guard. Continued priority 2 on `codex/candidate-review`, initially stacked on that PR, then fast-forwarded to the merged main before submission. The final capture screenshot visual-review note is included in this branch.

Candidate review implements explicit owner confirm, edit-and-confirm and dismiss across canonical records, HTTP and profile. Confirmation creates a separate user-authored `profile_confirmation` source and authoritative active `user_confirmed` revision. Original model roles, evidence and provider identity remain in earlier revisions. Dismissal retains a separate `dismissed` current state and history, excluding the active recall and candidate queue. Both actions are revision-checked and block old source extraction without waiting for model approval. Generic candidate editing directs callers to the explicit review route. Migration 005 extends allowed states/capture methods and records nullable per-revision provider identity; historical identities already cleared by older corrections cannot be reconstructed.

Final `pnpm check` passed **77/77 tests**, typechecking and the production profile build; both `pnpm demo` lifecycles/export-import passed. Focused core review checks passed **10/10** and authenticated HTTP/MCP owner review checks **3/3**. Coverage includes both model origins, confirmation edits, explicit dismissal, competing revision actions, same-scope sibling supersession, in-flight extraction and vector fencing, correction/confirmation/dismissal export-import, forged authority rejection, upgrade backfill and legacy bundle idempotence.

Final `pnpm integration` passed all **10 full-stack synthetic-provider stages**, native migration rerun and **34 hybrid/capture/review regressions** on PostgreSQL 17.11 / pgvector 0.8.7, including the legacy inactive correction import fix. The actual worker's inferred record was edited and confirmed through the owner HTTP API, then recalled with its new separate evidence by Client B. The model/source history remained distinct. An assistant proposal was dismissed and retained in export, then forgotten. Deleting the original preference also removed its confirmed sibling and confirmation source. Application image: `sha256:f05900434414ab4cfabd175a601df241af464a09683f828374617585cc7491c7`. Disposable project resources and credentials were removed.

Chromium **151.0.7922.173** passed **15 browser checks** on the final build, including explicit review, edit-and-confirm, retained original provider/source history, stale revision refresh, request/detail failure recovery, delayed completion across logout/login, extraction cancellation, fresh independent scoped HTTP recall, keyboard controls and 390px mobile overflow. No runtime exceptions; all seven screenshots were visually reviewed. [Browser evidence](measurements/review-ui-qa.json) uses disposable PGlite and a deterministic MemoryProvider, independently from native container evidence.

Local review reproduced and fixed compatibility with old v1 exports missing revision provider metadata: missing fields remain unknown and do not conflict with or erase known history. GitHub Codex reviewed [PR #5](https://github.com/ThomsenDrake/threadkeeper/pull/5) head `2f580698a0` and found one actionable legacy import edge: pre-005 exports could retain authority on superseded corrections. Import now validates exact owner-authored correction evidence, blocked history and revision provenance before clearing that obsolete flag. Forged authority remains rejected atomically; legitimate fresh import, repeat import and migration rerun pass on both PGlite and native PostgreSQL. Independent local review found no remaining actionable issue; `git diff --check` passed. GitHub review of the resulting final head is the remaining delivery checkpoint. Real-provider quality, GPU inference and installed MCP hosts remain separate release gates, with no configured access added here. No deployment, DNS, paid provisioning, publication or reusable Cloud settings changed.

Connection guidance and server capture pause are being implemented in isolated `/workspace/threadkeeper-client-control` (`codex/client-control`) from the same merged capture baseline. Deletion previews/source forgetting are being implemented in `/workspace/threadkeeper-forgetting` (`codex/forgetting-preview`). Integrate each onto current main and review its resulting head before any self-merge; these independent worktrees are not finished/merged product claims.

## Capture progress and recovery — 2026-10-03

Continued from fetched main `b8734a4` on `codex/capture-recovery`. No open PRs existed at kickoff. Read all required guidance and reconciled the backlog with merged hybrid/full-stack work. The initial pinned Node 24.19.0 / pnpm 11.25.0 baseline passed typechecking, **51 tests**, profile build and both `pnpm demo` lifecycles.

Priority 1 adds current capture-status lookup through HTTP and MCP, a paginated owner Captures view, source-only profile capture and safe owner retry of failed extraction. The immutable idempotency receipt remains separate from live canonical state. Scope metadata survives deletion so an old capture ID cannot bypass project restrictions; legacy captures with unrecoverable scope are visible only to the owner. Capture-only tokens inspect their own captures. Owner retry checks the observed attempt count, keeps the same source/capture/job IDs and cannot restore corrected or forgotten evidence. Corrections cancel unfinished jobs when no extractable source remains; completed historical jobs retain their terminal outcome. Current result IDs include only surviving records.

Observed validation: `pnpm check` passed **64/64 tests**, typechecking and the profile production build; both `pnpm demo` lifecycles/export-import passed. New core capture checks passed **9/9**, including both stale-success/stale-failure races, admission rollback, correction/deletion, scope isolation, pagination and legacy migration reruns. Authenticated HTTP/MCP capture checks passed **4/4**, including failure → owner retry → processing → one accepted result → independent recall.

`pnpm integration` passed all **9 full-stack scenario stages**, native migration rerun and **15 native hybrid HTTP/MCP/database tests** on PostgreSQL 17.11 / pgvector 0.8.7. The actual application worker used the keyless synthetic HTTP fixture with the exact Nemotron alias. Live processing, current failure, same-job retry, attempt 2, independent recall and correction/deletion cancellation passed. Application image: `sha256:71a79da776b44bf5e00c9a97de0e4036853cb5d2418195428ed7bd56bf0ef24b`. Disposable containers, network, volume, image and temporary credentials were removed. This run preceded two UI-only review fixes; database/API/worker code is unchanged after it.

Final `pnpm check` passed **64/64 tests**, typechecking and build after the two UI-only fixes. Chromium **151.0.7922.173** browser QA passed the capture lifecycle, failed-job retry, independent scoped HTTP recall, loading/failure recovery, keyboard controls and 390px mobile overflow checks with zero runtime exceptions. The delayed-response/sign-out regression and automatic memory refresh after completion both passed. Desktop, failed-state and mobile screenshots were visually reviewed; [browser evidence](measurements/capture-ui-qa.json) uses a disposable PGlite database and deterministic MemoryProvider. Independent final correctness review found no remaining actionable issue; `git diff --check` passed. GitHub review/merge remains the delivery checkpoint, to be recorded by the next reviewed increment. No learned model, provider-key, GPU or installed MCP host result is claimed. No deployment, DNS change, paid provisioning, public release or reusable environment change occurred.

Remaining product priorities are candidate review, connection guidance/use and server capture pause, deletion previews/source forgetting, larger memory-list pagination/import reporting, and deletion-aware operational recovery. Captures use bounded offset pagination and refresh visible pages while jobs are pending/processing; large-scale latency is not measured. Exports still omit capture/job receipts and credentials; imported sources do not automatically recreate extraction jobs. Retries cover failed jobs with surviving eligible evidence, rather than starting arbitrary new extraction from completed/cancelled captures.

## Autonomous development direction — 2026-10-03

The user now authorizes future broad development tasks to choose and deliver complete MVP product flows, run the GitHub `@codex review` loop, merge their own qualifying PRs, and continue to the next unblocked outcome. Follow [AGENTS.md](../AGENTS.md) and [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for final-head review/check requirements, the product backlog and existing deployment/DNS/spending/publication boundaries. A narrower explicit request still controls its task.

This guidance change is documentation only. `git diff --check` and relative Markdown link checks passed, and an independent local review found no remaining blocking issue. Application, demo, native PostgreSQL/pgvector and browser checks were not rerun for these documentation edits; the results below belong to the earlier hybrid and full-stack implementations. External Codex review and merge status are recorded on the guidance PR.

Hybrid recall is merged in PR #1. [PR #2](https://github.com/ThomsenDrake/threadkeeper/pull/2), containing full-stack integration and extraction attempt fencing, merged while this guidance was under review. This branch includes that main update (`b6b11ef`), and its evidence is retained below. Do not duplicate those changes. The next default product flow is scoped capture/job status and owner-controlled retry across HTTP/MCP and the profile. Missing real-provider credentials or GPU/installed-host access should block only dependent checks while independent product work continues.

## Full-stack integration evidence — 2026-10-03

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

Continue product development using [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md), beginning with observable capture progress and safe retry unless current code or dependencies change that priority. Full application container validation is now recorded in the full-stack evidence above. Real embedding quality and installed MCP hosts remain verification work; run access-dependent checks when their configuration is available. Preserve explicit client-invoked capture/recall, authoritative profile corrections and deletion behavior. Rerun the checks/demo and relevant native/browser tests after behavioral changes; record results instead of treating configuration as proof.

## Review follow-up — 2026-10-03

The requested GitHub `@codex review` of `88ac4d4` completed with no findings. A parallel local review found that the embedding adapter discarded an explicit response model identity and always reported the configured model. Same-dimensional vectors from a detectably different model could therefore enter the configured space.

The adapter now rejects an explicit different model (`embedding_model_mismatch`) and malformed identities before accepting vectors. Matching identities and endpoints that omit the optional field remain supported. Two regressions exercise substitution, recovery, omission and malformed values. `pnpm check` passed all **44 tests**, typechecking and build, and `pnpm demo` passed both full-text and hybrid lifecycle/export-import paths after this fix. These updates are submitted for another GitHub Codex review. Native database and browser checks above belong to the original hybrid commit; they were not rerun for this provider-response validation change.

## Earlier evidence retained

Prior live synthetic Nemotron/embedding observations are recorded in [PROVIDER_VERIFICATION.md](PROVIDER_VERIFICATION.md) and [nebius-extraction.json](measurements/nebius-extraction.json). They established the exact Nemotron ID, JSON-object output, a no-side-effect tool call, two source-backed extraction records and a 4096-dimensional Qwen response through the developer's authenticated integration. They are historical evidence, not new API-key worker or hybrid-quality checks from this Cloud task. Earlier Chromium 153 visual screenshots remain in [ui-qa.json](measurements/ui-qa.json); the new browser regression evidence is separate.

## Client connection and capture controls — 2026-10-03

Priority 3 is implemented on `codex/client-control`, based on the merged capture-recovery tree (`26c025d`). This branch is prepared for integration after priority 2; its GitHub PR/review/merge remain for the coordinating session to complete. The profile now supplies the exact configured remote MCP endpoint, generic endpoint/header JSON and a first explicitly authorized synthetic capture/recall walkthrough. Tokens stay in the transient creation dialog and are removed from application state when it closes or the owner signs out. Scope labels explicitly show that restricted projects also include global personal context. Credential issuance is shown separately from **Never used** / **Last authenticated request**; an active credential never implies an installed host or a captured transcript.

The owner can pause/resume new captures through Connections or owner-only `GET/PATCH /api/settings/capture`. Database capture admission checks `tk_owners.capture_paused` under the same owner lock before returning even an idempotent receipt. All new profile/client capture requests are rejected with HTTP 403 `capture_paused` while paused; permitted reads and existing data remain available. Already admitted queued or explicitly retried extraction can complete, with its existing attempt, correction and deletion fences intact. Pause does not revoke a credential or delete saved context. The separate `capture_settings_version` guards stale owner changes without conflicting with unrelated memory writes. `006_client_control.sql` adds the settings and a nullable client authentication timestamp; update the migration lists alongside the priority-2 migration when integrating the two branches.

Verification on this branch: Node 24.19.0 and pinned pnpm 11.25.0 installed with the frozen lockfile; `pnpm check` passed typechecking, all **67 tests** and the production React build. `pnpm demo` passed both full-text and synthetic pgvector lifecycle/export-import demonstrations. New acceptance tests execute the exact CLIENTS.md capture example through two independent SDK clients configured with the same generic endpoint/header object the profile supplies. They exercise project/global isolation, owner-only settings, creation vs authenticated-request timestamps, capture pause including profile/replay, permitted recall, resume, revocation, concurrent settings revisions, paused retry and an in-flight deletion fence. An initial broad run failed because the new test shared the hybrid suite's port; it now uses dedicated port 3194 and the suite passed after the collision was removed.

The actual built profile served by Express with disposable PGlite also passed Chromium browser verification: token and connection JSON copying, two independent SDK transports using the copied values, the authorized walkthrough, last-use refresh, pause/recall, stale-setting recovery, settings/endpoint failures and retry, revoke/401, mobile layouts and sign-out. Desktop and mobile screenshots were visually reviewed. Evidence is [client-control-ui-qa.json](measurements/client-control-ui-qa.json). Tokens were synthetic and excluded from recorded evidence/screenshots. No inference provider, native database/container runtime, installed ChatGPT/Codex host or GPU behavior was tested by this increment; those remain separate release gates.

Local review found that a committed pause/resume whose response was lost could leave the UI showing its old state. Settings responses are now validated, every failed mutation invalidates the displayed setting and rereads canonical state, and failed recovery keeps profile capture/toggle actions unavailable. The follow-up browser regression verifies a committed Resume with an aborted response and a committed Pause with malformed success JSON followed by a failed recovery read; refresh recovers the actual state in both directions. The rebuilt profile passed after this fix.

Integration follow-up: the client-controls commit is now explicitly stacked on priority 2 (`2f58069`) and preserves its review routes/contracts, owner review permission, per-revision extractor history, dismissal/import rules and dialog focus handling. Both migrations run in order (`005_candidate_review.sql`, then `006_client_control.sql`). The combined branch passed `pnpm check` with **79 tests**, typechecking and production build, and both synthetic `pnpm demo` paths. The rebuilt combined profile and current API passed the full client-controls browser/independent-SDK flow again, including mobile token/walkthrough controls and committed-response-loss recovery. The UI and documentation now use the same `capture_method` in their shared first-context example, avoiding a changed-payload idempotency conflict when switching between them. Final prerequisite-aware GitHub review/merge is still coordinated by the parent session.

Native acceptance preparation: cherry-picked the prerequisite's validated legacy superseded-correction import fix (`e73661e`) while retaining both feature handoffs and their historical counts. The full-stack harness now includes a client-controls stage using the exact configured endpoint with generic SDK connection data, separate creation/authentication timestamps, paused new/profile/replay rejection, retained recall, existing worker completion, stale settings rejection, resume and revoked-use fencing. Its native regression invocation includes the existing `api-client-control.test.ts`; that fixture now opts into the helper's isolated native schemas when a disposable native test URL is supplied. The runner derives its test count from TAP. Typechecking passed after integration; final full-stack and combined baseline results are still pending and must be recorded as actual outcomes.

Final client-controls acceptance: `pnpm check` passed **80/80 tests**, typechecking and the production build after the legacy import fix and native fixture opt-in; both `pnpm demo` paths passed. `pnpm integration` passed all **11 full-stack stages**, native migration rerun and **37 native-enabled regression checks** on PostgreSQL 17.11 / pgvector 0.8.7. The new stage used the actual API, worker/provider HTTP adapter and two independent MCP SDK transports to verify exact configured connection guidance, separate authenticated-use timestamps, new/profile/replay pause rejection, retained recall, previously admitted extraction completion, stale setting rejection, resume and revocation timestamp fencing. The existing client-control API fixtures ran against isolated native schemas; explicit fallback fixtures elsewhere remain PGlite. Application image: `sha256:8b85c3e404328c9b06c3671af999c73631b81ee1fe0c8c1ec137f3986a2a4517`. Disposable containers, network, volume, image and generated credentials were removed. Sanitized evidence is [client-control-integration.json](measurements/client-control-integration.json). These synthetic observations establish neither installed-host behavior nor learned-model/GPU quality. The profile asset hash remains the same as the already recorded combined browser check.
