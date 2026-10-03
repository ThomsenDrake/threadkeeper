# Local Codex handoff

## Current state

This is a new local TypeScript starter created after the workspace contained no existing implementation. A remote repository implementation was not available through the exposed development tools. No publication, deployment, paid provisioning or DNS changes occurred. The existing domain/Cloudflare migration is separate user-reported work.

The slice contains React profile, Node HTTP/OpenAPI and MCP service, local owner authentication, scoped/revocable clients, PostgreSQL memory lifecycle and a small extraction worker. Nemotron is the dedicated memory model. Threadkeeper remains focused on personal context.

Codex Cloud preparation is in `docs/CODEX_CLOUD.md`. The portable install script is `bash scripts/codex-cloud-setup.sh`, using Node.js 24 and pnpm 11.25.0. It runs the credential-free checks and synthetic demo. The private GitHub repository is `ThomsenDrake/threadkeeper`, created on 2026-10-03. No Codex Cloud environment or task has been run.

## Evidence established during this session

- Typechecking and the Vite production build passed.
- Focused core/provider suites passed at the recorded revision; rerun the entire suite after changes rather than relying on a frozen test count.
- A real HTTP/Streamable MCP transport test used two separate authenticated SDK clients. Both observed profile HTTP correction/deletion, evidence removal, stale-write rejection and credential revocation. Origin rejection was checked.
- The central deterministic lifecycle and fresh-database export/import are reproducible with `pnpm demo` using PGlite, explicit synthetic entries and core principals.
- `pnpm dev:demo` starts a disposable synthetic PGlite profile on `http://127.0.0.1:3000`, using `demo@example.invalid` / `threadkeeper-demo-password`. It invokes no inference and retains no data after exit.
- Authenticated synthetic Nebius checks found the exact Lightning ID, valid JSON-object output, a no-side-effect tool call and two validated extraction records after an effective-time prompt correction. Token counts and failures are recorded in `PROVIDER_VERIFICATION.md`.
- Qwen embeddings returned 4,096 finite dimensions. No semantic retrieval integration is complete.
- The recorded live Nemotron extraction response passed the shared application validator and a worker/database replay accepting 2 records and skipping 0. Evidence: `docs/measurements/nebius-extraction.json`. Live inference used the developer's authenticated integration; this was not a direct worker API-key call.
- Compose YAML parses. Docker is absent in this environment, so container build/run and native PostgreSQL/pgvector checks did not run.
- Chromium 153 browser verification passed against a disposable PGlite-backed API: local sign-in, separate explicit captures, all four filters, evidence/revisions and capture method, correction/deletion, search, client grants and fresh HTTP recall, JSON export/import, immediate revocation, sign-out and a mobile layout without horizontal overflow. Desktop (1440 × 1000), provenance drawer and mobile (390 × 844) screenshots were visually reviewed. Evidence: `docs/measurements/ui-qa.json`, `profile.png`, `profile-evidence.png` and `profile-mobile.png`. This browser flow does not establish cloud inference, native containers or installed MCP host integrations.

These do not establish live hosting, actual installed chatbot/coding-agent integrations, robust paraphrase reconciliation, local GPU inference, offline operation or feature parity.

## Known implementation limits

- Search is PostgreSQL full-text plus substring matching; semantic retrieval and context synthesis remain unfinished.
- Model reconciliation rejects bad evidence and stale exact statements, but conflict/dedup handling across paraphrases requires measured work.
- Candidate/inference and assistant-proposal records are distinct. Full review-status workflows and contradiction handling remain limited.
- Deletion removes whole connected source events and sibling memories. Span-level preservation and an affected-record preview remain future work.
- Known deletion tombstones block exact replay; arbitrary paraphrase reinstatement is not guaranteed.
- Existing-client automatic invocation is not tested. MCP SDK test clients are not the actual ChatGPT/Codex host applications.
- Backup restore deletion reconciliation, a migration ledger, upgrade/recovery procedures and full self-hosted inference/embedding containers still require implementation and execution.
- There is no client job-status polling or failed-job retry endpoint. Diagnose failed jobs through database metadata and worker logs. The worker can reclaim processing jobs after ten minutes using `started_at`; recovery/retry validation and robust attempt fencing remain unfinished.
- OSS license is undecided; select it before publishing. Do not add feature gates or mandatory hosted accounts.

## Next build order

1. Inspect all source and docs, install the locked dependencies and run `pnpm check` and `pnpm demo`. Rerun browser QA after UI/API changes; the recorded synthetic browser flow covers sign-in, capture, all four filters, search, provenance, edit/delete, connection revocation and export/import.
2. Build/run Compose with private operator secrets, validate native PostgreSQL and optional pgvector setup, and run the central MCP/profile demonstration against that stack.
3. Rerun the actual extraction/provider checks through `.env`, then run capture without explicit records through the live worker. Record successes/failures and usage accurately.
4. Test at least two independent installed MCP host integrations with concise recall/capture instructions. Prefer one chatbot and one coding agent. Do not require the original developer's private Executor.
5. Integrate configurable semantic retrieval and rebuild tooling, verify embedding preprocessing/dimensions, and measure a small synthetic quality corpus before adding optional reranking or extra infrastructure.
6. Run the full local inference/embedding setup on suitable hardware. Pin the tested model/runtime recipe and demonstrate identical application behavior without Nebius/Threadkeeper credentials or hosted control-plane access.
7. Implement deletion-aware restore/reimport handling and operational tests. Complete release evaluation, license selection and an authorized public demo/deployment.

## Kickoff prompt

```text
Continue Threadkeeper from this repository. First inspect README.md, docs/HANDOFF.md,
docs/MVP_BRIEF.md, docs/DECISIONS.md and docs/PROVIDER_VERIFICATION.md, then inspect
the code. Follow Drake's user-confirmed product requirements from the project brief.
Run pnpm install --frozen-lockfile, pnpm check and pnpm demo before changing behavior.

Prioritize the complete deadline/preference cross-client lifecycle. Browser QA
has passed on disposable PGlite; build and run Docker Compose against native PostgreSQL/pgvector. Use only
synthetic demo data. Read local operator-managed secrets from an ignored .env;
never ask for secrets in chat or commit them. Rerun actual provider checks and test
the worker with nvidia/Nemotron-3_5-Lightning. Do not silently replace the model.

SDK clients already exercise server transport, but actual chatbot/coding-agent
integrations still require validation. Keep MCP capture and recall client-invoked.
Integrate semantic retrieval only with verified embeddings, preprocessing and
dimensions. Complete a pinned and measured local inference/embedding deployment
and demonstrate feature parity without Nebius or Threadkeeper accounts.

Implement deletion-aware restore and operational tooling. Keep source evidence
separate from interpretation, scoped authorization in code, versioned user
corrections authoritative and deletions effective in fresh recall. Deletion is
currently conservative at whole connected source-event granularity; do not claim
fine-grained or semantic guarantees that are not implemented and tested.

Keep the product a personal-context service, not an assistant or task manager.
No feature gates, mandatory hosted control plane or private Executor dependency.
Update the handoff with what actually ran, passed and remains blocked. A license
must be chosen before publication. Do not alter DNS or deploy without a concrete
authorized deployment task.
```
