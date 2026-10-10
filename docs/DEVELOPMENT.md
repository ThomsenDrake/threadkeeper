# Development guide

[README.md](../README.md) is the customer introduction: what Threadkeeper does, how someone runs it, and how a client connects. This guide is for people changing the repository. Keep agent status, corpus scores, and local-check recipes here and in the documents below. Do not put them back in the README.

## Read before architectural changes

Product responsibility is personal context for existing clients through MCP. Do not add a general assistant or task manager.

| Document | Use it for |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Execution, review, merge, and product invariants |
| [MVP_BRIEF.md](MVP_BRIEF.md) | Product contract and acceptance gates |
| [DECISIONS.md](DECISIONS.md) | Confirmed implementation choices and open decisions |
| [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) | Autonomous delivery loop and the six implemented outcomes |
| [HANDOFF.md](HANDOFF.md) | Evidence log, access limits, and the next executable step |
| [CLIENTS.md](CLIENTS.md) | MCP and HTTP client contract |
| [PORTABILITY.md](PORTABILITY.md) | Export, import, deletion, backup, and restore |
| [PROVIDER.md](PROVIDER.md) | Model and embedding adapter contract |
| [PROVIDER_VERIFICATION.md](PROVIDER_VERIFICATION.md) | Measured provider checks and their limits |
| [RETRIEVAL.md](RETRIEVAL.md) | Hybrid recall setup and limits |
| [INTEGRATION.md](INTEGRATION.md) | Disposable native full-stack harness |
| [DIRECT_PROVIDER_LIFECYCLE.md](DIRECT_PROVIDER_LIFECYCLE.md) | Direct learned-provider acceptance procedure |
| [CODEX_CLOUD.md](CODEX_CLOUD.md) | Codex Cloud environment preparation |

The customer run steps live in the README. Operator restore commands live in [PORTABILITY.md](PORTABILITY.md). Prefer [HANDOFF.md](HANDOFF.md) when it disagrees with the status snapshot below.

## What the application includes

- Local owner sign-in, and revocable client tokens with read or capture permission and project scopes.
- MCP capture, live capture-status lookup, recall, and source lookup, plus a secondary HTTP/OpenAPI interface.
- PostgreSQL source records, evidence links, memories, revisions, jobs, and non-content deletion tombstones.
- Explicit captures and a bounded worker extraction adapter. The Nebius preset is `nvidia/Nemotron-3_5-Lightning`.
- Paginated profile browsing and search, with loaded and matched counts, subject, project, source, and status filters, provenance, revision-checked correction, deletion, client access, and counted atomic import and export. Recent captures show current processing outcomes and let the owner retry eligible failed extraction jobs.
- Credential-free PostgreSQL full-text search with a substring fallback, plus optional hybrid recall through configurable OpenAI-compatible embedding endpoints, including self-hosted servers. See [RETRIEVAL.md](RETRIEVAL.md).

Profile corrections create user-authored `user_confirmed` evidence and make the current revision authoritative immediately. All admitted origins are current and delivered with their original label, including inferences and assistant contributions. Origin is provenance only; every current memory follows the same lifecycle with no approval queue. Migration 009 and imports make old candidates available without changing their origins and preserve explicit legacy dismissals outside default recall. Original sources and provider history stay inspectable. Model output stays bounded and locally validated. Source instructions cannot control owner IDs or permissions.

Before forgetting a memory or saved source, the profile shows the affected source events, current memories, history counts, and extraction jobs. Confirmation rechecks that exact impact, including sibling interpretations and known normalized source copies, so a concurrent change requires a fresh preview. Sources awaiting extraction can also be forgotten.

Deletion removes whole connected source events and all memories supported by them, including revision history and intersecting extraction jobs. This is deliberately conservative and can remove sibling memories or identical normalized source copies in other projects. A removed job's other surviving sources are not automatically requeued. The central demonstration uses separate deadline and preference events. The full operator contract is [PORTABILITY.md](PORTABILITY.md).

The versioned export preserves remaining records, evidence, and corrections, with non-content tombstones. It excludes accounts, credentials, and access grants. An older backup can contain forgotten data. The isolated recovery utility reconciles a newer owner deletion ledger before permitting services to start, revokes restored credentials, and resets owner passwords.

Complete self-hostability with feature parity is a binding release requirement. Model and embedding endpoints are configurable. Packaging alone does not demonstrate GPU compatibility or operation without external control-plane access. Managed deployments may charge for operations and resources. They do not receive an exclusive application feature.

## Local checks

Prerequisites: Node.js 24 and pnpm 11.25.0. Initial dependency downloads require network access.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

`pnpm check` runs typechecking, focused tests, and the profile build. The test database is PostgreSQL via PGlite in WebAssembly, not a native PostgreSQL deployment. `pnpm demo` runs deterministic full-text and pgvector hybrid walkthroughs with synthetic embeddings, explicit captures, and fresh-database export and import. It invokes neither a learned model nor a browser.

With Docker, BuildKit, and Compose 2.24.4 or newer, reproduce the full application stack and the worker/provider HTTP lifecycle:

```sh
pnpm integration
```

This uses native PostgreSQL and pgvector, the API serving the built profile, the worker, and a deterministic local HTTP fixture. It creates disposable credentials and resources, reports stage failures, and cleans up. It validates synthetic integration. Real inference and GPU checks remain separate. See [INTEGRATION.md](INTEGRATION.md) and [HANDOFF.md](HANDOFF.md).

For a disposable profile in the browser, after `pnpm build`:

```sh
pnpm dev:demo
```

Open `http://127.0.0.1:3000`. Synthetic demo credentials are `demo@example.invalid` / `threadkeeper-demo-password`. This binds locally, uses a disposable PGlite database, and performs no inference. Data disappears when it exits. The customer-facing container steps are in the README.

## Host-run API and worker

The Compose command in the README is the operator path. For a host-run application against an already available PostgreSQL database, set `DATABASE_URL` in `.env`, then run these in separate terminals:

```sh
pnpm build
node --env-file=.env --import tsx apps/api/src/index.ts
node --env-file=.env --import tsx apps/worker/src/index.ts
```

With `APP_ORIGIN=http://localhost:3000`, use that exact origin. Host and Origin checks reject mismatches. Public hosting also requires HTTPS and `COOKIE_SECURE=true`. No public hosting has been configured here.

## Provider checks

Use operator-managed environment secrets to rerun synthetic provider checks:

```sh
node --env-file=.env --import tsx deploy/provider-check.ts
```

The script records separate checks and skips embeddings unless `EMBEDDING_MODEL` is configured. JSON-schema probing is opt-in via `PROVIDER_CHECK_SCHEMA=true`. Do not silently change the memory model when a check fails. A local compatible inference endpoint needs no Nebius credentials. The selected local checkpoint alias must match that server.

Create one credential per client in the profile. Connect it to `/mcp` with a bearer token, or use the operations described by `/openapi.json`. See [CLIENTS.md](CLIENTS.md). Installing an MCP server does not mean a host captures conversations or recalls memories automatically.

## Status snapshot

This is the compact status that previously lived in the README. [HANDOFF.md](HANDOFF.md) is the evidence log. Prefer a later handoff entry when it disagrees with this snapshot.

Owners can also correct a current memory’s kind. Each revision retains its own classification; history keeps the original provider attribution alongside the separate owner-authored revisions. Current exports use v2; legacy v1 imports remain supported. See [portability and upgrade compatibility](PORTABILITY.md).

The central lifecycle has passed through independent MCP SDK clients and installed Codex hosts using explicit tool invocations. A separate [published OpenCode 1.18.34 run](OPENCODE_HOST_VALIDATION.md) passed model-selected capture and recall under explicit prompts: capture two source events, extract through direct Nebius, recall from a separate client, correct the deadline and forget the preference, then recall only the corrected record from two fresh host sessions. This used the canonical worker in process on PGlite, full-text recall, 12 direct chats and zero embeddings; it does not establish unprompted capture or final-answer quality. Codex model turns and installed ChatGPT/Claude hosts remain unverified. See [client instructions](CLIENTS.md) and [raw OpenCode evidence](measurements/opencode-learned-host.json).

The profile UI passed a synthetic Chromium 153 browser walkthrough against a disposable PGlite-backed API: sign-in, capture, all four filters, provenance, revision-aware correction and deletion, search, scoped client creation and revocation, export and import, and sign-out. Desktop, provenance, and mobile screenshots were visually reviewed. See [browser evidence](measurements/ui-qa.json). This browser test did not use inference or a deployed service.

Direct application calls to Nebius have verified exact Nemotron model access, JSON-object output, a no-side-effect tool call and source-backed extraction. A separate fresh [seven-control taxonomy probe](ASSERTION_KIND_PROBE.md) scored **4/7** after generic kind clarification: a faithful limit was mislabeled, a fact was omitted and a report lost explicit attribution framing. No template-only false negatives were found or causal improvement established. The earlier [eight-case v2 observation](EXTRACTION_HOLDOUT.md) scored **3/8** under its frozen rubrics: dialogue content and a quoted command were wrongly admitted, one job failed, and one faithful timestamped assertion failed only the finite template. Manual review is recorded separately without changing the score. V2 repeats the same semantic cases with opaque IDs; the historical v1 **5/8** was not fully blinded, and the score difference does not establish an identifier effect. The earlier eleven-case corpus remains **8/11**, with all failures preserved. Broader extraction quality remains a release gate. A separate direct Qwen batch returned nine 256-dimensional vectors and ranked four labelled paraphrase queries correctly. See [provider evidence](PROVIDER_VERIFICATION.md) for usage, failures and limits.

Native PostgreSQL 17.11 / pgvector 0.8.7 and the application containers have also been exercised locally. The credential-free [full-stack integration harness](INTEGRATION.md) uses synthetic provider HTTP responses. The strengthened [direct learned-provider native lifecycle](DIRECT_PROVIDER_LIFECYCLE.md) passed all four acceptance groups at source `28a83b8` with the actual API and worker, Nemotron extraction, source-backed Qwen semantic recall, scoped authorization, owner correction, and preview-confirmed forgetting with replay fences, source checksums, and binding of both initial vectors and the corrected vector to their observed provider results. Eight direct requests reported 1,832 tokens with complete accounting. [PR #15](https://github.com/ThomsenDrake/threadkeeper/pull/15) records review and merge status. This native source contains neither of PR #16’s literal qualifier guards. Local GPU inference, managed hosting, robust semantic reconciliation, and release-quality evaluation remain unverified.

The standard Compose stack has passed a disposable build, startup, profile, and sign-in check. `pnpm integration` adds native lifecycle and worker HTTP fixture validation. Configure an operator-managed provider for actual inference.

Deployment, DNS, paid provisioning, publication, and license selection remain outside agent authorization. See [AGENTS.md](../AGENTS.md) and [HANDOFF.md](HANDOFF.md). Keep real personal history, employer data, and credentials out of demos and source control.
