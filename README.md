# Threadkeeper

**Switch agents. Keep the thread.**

Threadkeeper is a personal-context service for existing chatbots and coding agents, with an editable profile and MCP as its primary integration. The intended public domain is `threadkeep.si`. A dedicated memory model extracts source-backed records; database code owns authorization, corrections, revisions and deletion. It does not perform the user's general tasks.

This repository is an early MVP hosted privately at [ThomsenDrake/threadkeeper](https://github.com/ThomsenDrake/threadkeeper). It has not been publicly released or deployed. The OSS license is still undecided and must be selected before public release.

## What works in the current slice

- Local owner sign-in; revocable client tokens with read/capture permissions and project scopes.
- MCP capture, live capture-status lookup, recall and source lookup, plus a secondary HTTP/OpenAPI interface.
- PostgreSQL source records, evidence links, memories, revisions, jobs and non-content deletion tombstones.
- Explicit captures and a bounded worker extraction adapter. The Nebius default is `nvidia/Nemotron-3_5-Lightning`.
- Paginated profile browsing/search with loaded/matched counts, subject/project/source/status filters, provenance, revision-checked correction, deletion, client access and counted atomic import/export. Recent captures show current processing outcomes and let the owner retry eligible failed extraction jobs.
- Credential-free PostgreSQL full-text search with a substring fallback, plus optional hybrid recall through configurable OpenAI-compatible embedding endpoints, including self-hosted servers. See [retrieval setup and limits](docs/RETRIEVAL.md).

The central lifecycle has passed through two independent authenticated MCP SDK clients, two installed Codex app-server hosts using explicit tool invocations, and owner HTTP operations: capture a deadline and preference, recall from the other client, correct the deadline, delete the preference, then recall the new state from both. Autonomous model tool selection and installed ChatGPT or other hosts remain unverified. See the [client instructions](docs/CLIENTS.md) and [installed Codex evidence](docs/measurements/codex-host-qa.json).

The real profile UI also passed a synthetic Chromium 153 browser walkthrough against a disposable PGlite-backed API: sign-in, capture, all four filters, provenance, revision-aware correction/deletion, search, scoped client creation and revocation, export/import and sign-out. Desktop, provenance and mobile screenshots were visually reviewed; see [browser evidence](docs/measurements/ui-qa.json). This browser test did not use inference or a deployed service.

Direct application calls to Nebius have verified exact Nemotron model access, JSON-object output, a no-side-effect tool call and source-backed extraction. The latest stricter synthetic corpus passed 10/11 rubrics, with an explicit effective timestamp still omitted in one interpretation despite its full source quote (an earlier sample passed 11/11); a direct Qwen batch returned nine 256-dimensional vectors and ranked four labelled paraphrase queries correctly. See [provider evidence](docs/PROVIDER_VERIFICATION.md) for failures, token usage and limits. Native PostgreSQL 17.11/pgvector 0.8.7 and the application containers have also been exercised locally. The credential-free [full-stack integration harness](docs/INTEGRATION.md) uses synthetic provider HTTP responses, distinct from those historical real-provider observations. Local GPU inference, managed hosting, robust semantic reconciliation and release-quality evaluation remain unverified.

## Run local checks

Prerequisites: Node.js 24 and pnpm 11.25.0. Initial dependency downloads require network access.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

`pnpm check` runs typechecking, focused tests and the profile build. The test database is PostgreSQL via PGlite in WebAssembly, not a native PostgreSQL deployment. `pnpm demo` runs deterministic full-text and pgvector hybrid walkthroughs with synthetic embeddings, explicit captures and fresh-database export/import. It invokes neither a learned model nor a browser.

With Docker, BuildKit and Compose 2.24.4 or newer, reproduce the full application stack and actual worker/provider HTTP lifecycle:

```sh
pnpm integration
```

This uses native PostgreSQL/pgvector, the API serving the built profile, the worker and a deterministic local HTTP fixture. It creates disposable credentials/resources, reports stage failures and cleans up. It validates synthetic integration; real inference and GPU checks remain separate. See [requirements and checks](docs/INTEGRATION.md) and [actual results](docs/HANDOFF.md).

For an immediately runnable, disposable profile demonstration:

```sh
pnpm build
pnpm dev:demo
```

Open `http://127.0.0.1:3000`. Synthetic demo credentials are `demo@example.invalid` / `threadkeeper-demo-password`. This binds locally, uses a disposable PGlite database and performs no inference. Data disappears when it exits; use the persistent container setup for actual use.

## Run the application with containers

Docker and Compose are required. The standard Compose stack has passed a disposable build/startup/profile/sign-in check; `pnpm integration` adds native lifecycle and worker HTTP fixture validation. Configure an operator-managed provider for actual inference.

```sh
cp .env.example .env
```

Set `POSTGRES_PASSWORD`, `BOOTSTRAP_EMAIL` and a `BOOTSTRAP_PASSWORD` of at least 12 characters in your private `.env`. Use a URL-safe database password for this Compose configuration. For the hackathon worker, configure `NEBIUS_API_KEY` securely. Do not commit `.env` or paste secrets into chat.

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build
```

Open `http://localhost:3000` and sign in as the bootstrapped owner. The API serves the built profile and applies checksum-tracked transactional migrations before listening. The worker starts after API/database readiness. PostgreSQL uses a named data volume; ports are published to localhost. Changing the bootstrap settings after an owner exists does not change that owner's password.

For a host-run application against an already available PostgreSQL database, set `DATABASE_URL` in `.env`, then run these in separate terminals:

```sh
pnpm build
node --env-file=.env --import tsx apps/api/src/index.ts
node --env-file=.env --import tsx apps/worker/src/index.ts
```

With `APP_ORIGIN=http://localhost:3000`, use that exact origin. Host and Origin checks reject mismatches. Public hosting also requires HTTPS and `COOKIE_SECURE=true`; no public hosting has been configured here.

## Provider and client checks

Use operator-managed environment secrets to rerun synthetic provider checks:

```sh
node --env-file=.env --import tsx deploy/provider-check.ts
```

The script records separate checks and skips embeddings unless `EMBEDDING_MODEL` is configured. JSON-schema probing is opt-in via `PROVIDER_CHECK_SCHEMA=true`. Do not silently change the memory model when a check fails. Local compatible inference endpoints need no Nebius credentials; the selected local checkpoint alias must match that server.

Create one credential per client in the profile. Connect it to `/mcp` with a bearer token, or use the operations described by `/openapi.json`. See [client instructions](docs/CLIENTS.md). Installing an MCP server does not guarantee that a host captures conversations or recalls memories automatically.

## Corrections, deletion and portability

Profile edits create user-authored correction evidence and make the current revision authoritative. Owners explicitly confirm, edit-and-confirm or dismiss model candidates in Needs review. Confirmation creates separate user-confirmed evidence; original inference/proposal sources and provider history stay inspectable. Dismissed records remain in history and stay out of default recall. Fresh default retrieval uses active current records. Model output remains bounded and locally validated; source instructions cannot control owner IDs or permissions.

Before forgetting a memory or saved source, the profile shows the affected source events, current memories, history counts and extraction jobs. Confirmation rechecks that exact impact, including sibling interpretations and known normalized source copies, so a concurrent change requires a fresh preview. Sources awaiting extraction can also be forgotten.

Deletion removes **whole connected source events and all memories supported by them**, including revision history and intersecting extraction jobs. This is deliberately conservative and can remove sibling memories or identical normalized source copies in other projects. A removed job's other surviving sources are not automatically requeued. Capture independent facts in separate source events for precise deletion. The central demonstration uses separate deadline and preference events.

The versioned export preserves remaining records, evidence and corrections, with non-content tombstones. It excludes accounts, credentials and access grants. An older backup can contain forgotten data. The isolated recovery utility reconciles a newer owner deletion ledger before permitting services to start, revokes restored credentials and resets owner passwords. See [portability and operations](docs/PORTABILITY.md) before restoring a database.

Complete self-hostability with feature parity is a binding release requirement. Model/embedding endpoints are configurable, but packaging alone does not demonstrate GPU compatibility or operation without external control-plane access. Managed deployments may charge for operations and resources, never exclusive application features.

## Continue development

- [Autonomous MVP development and product priorities](docs/DEVELOPMENT_PLAN.md)
- [Codex Cloud setup](docs/CODEX_CLOUD.md)
- [Compact MVP brief](docs/MVP_BRIEF.md)
- [Decisions and blockers](docs/DECISIONS.md)
- [Provider verification](docs/PROVIDER_VERIFICATION.md)
- [Local Codex handoff](docs/HANDOFF.md)

No DNS, registrar, Cloudflare or deployment changes were made by this implementation. No remote implementation was available for inspection; the starter was created locally after workspace inspection. Keep real personal history, employer data and credentials out of demos and source control.
