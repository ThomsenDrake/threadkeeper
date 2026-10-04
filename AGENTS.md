# Threadkeeper development

Read docs/DEVELOPMENT.md before architectural changes. It points to the product contract in docs/MVP_BRIEF.md, docs/DECISIONS.md and docs/HANDOFF.md. README.md is the customer-facing introduction. Keep agent status, scores, and local-check recipes out of it. Product responsibility is personal context for existing clients through MCP. Do not add a general assistant or task manager.

## Autonomous product development

The standing user direction is to develop the complete Threadkeeper MVP autonomously. When a task asks to continue development, read docs/DEVELOPMENT_PLAN.md, inspect current code and open PRs, and choose the highest-value unfinished product outcome. A narrower explicit user request still controls that task's scope.

Own prioritization, implementation, routine design decisions, debugging, testing and review. Deliver complete user/client flows across the profile, contracts, API/MCP, worker and database as needed. Prefer usable product progress. Testing, fixtures, infrastructure and documentation support delivery; they should not become the default session goal when product features can be implemented. A concrete defect blocking delivery is a valid reason to work on those foundations first.

Maintain a short working plan and use parallel agents for independent work. After completing one coherent increment, continue to the next unblocked priority in the same task. A passing baseline, finished test harness, opened PR or completed review is a checkpoint, not the default stopping point for a broad development request. Do not repeatedly ask the user what to build next or whether to continue when the MVP requirements and current evidence are sufficient.

Work on `codex/` branches and keep PRs reviewable. Inspect pending work before duplicating it. Continue independent work from main, or explicitly stack a dependent branch/PR on its prerequisite; document the dependency and do not merge someone else's work to unblock yourself. Self-review the complete change, use an independent local reviewer when available, assess findings, fix actionable issues and verify the fixes. Review the final commit after all edits and record the reviewed head and evidence in the PR. The user's 2026-10-04 direction removes GitHub `@codex` tagging and a review-service response as delivery requirements; do not post those tags or treat review-service quota as a merge blocker. Required repository checks and approvals still apply.

The user authorizes sessions to merge their own PRs after that self-review loop. Before merging, verify that the current head SHA received final self-review, all actionable findings are addressed, relevant local checks and required remote checks pass, and branch protection permits the merge. Do not bypass required approvals or merge a newer unreviewed head; use an expected-head SHA guard where available. After merging a completed increment, update from main and continue the next unblocked product outcome in a broad development task. Use stacked PRs only when prerequisites are explicitly tracked and do not treat prerequisite changes as reviewed automatically. Before self-merging a stacked PR, wait for prerequisites to merge, update/retarget it to main and review the resulting head; do not merge into another task's branch.

Use available authorized provider configuration and disposable local resources. Missing provider credentials, GPU hardware or an installed MCP host blocks only the checks that need them. Complete independently testable product behavior and label synthetic evidence accurately. Never request secrets in chat, silently select a different memory model, or equate a fixture pass with real-provider quality.

Continue until the MVP acceptance criteria are implemented and all available verification has passed, the user redirects the task, or no meaningful authorized work remains unblocked. Before stopping for a blocker, complete independent work and record the exact missing access/decision, implemented outcomes, test evidence, open PRs and next executable steps in docs/HANDOFF.md. If execution ends before the broad goal is complete, record it as partial progress rather than declaring the app finished. Context compaction or the completion of an individual subtask is not a reason to stop.

This standing direction authorizes development, review and self-merging under the conditions above. Deployment, DNS changes, paid provisioning, public release/license selection and changes to reusable Cloud environment settings still require explicit user authorization. Do not create or schedule new user-owned tasks unless requested.

## Product invariants

Preserve source evidence independently from interpretations. Database code owns authorization, current revisions, corrections, deletion and transactions. User profile corrections require no model approval. Never infer acceptance of assistant suggestions from silence. Use synthetic data in demos, tests and recorded provider measurements.

All application features must be self-hostable with no hosted account, license check, telemetry requirement, cloud-only capability or paid feature gate. Exact hackathon default: nvidia/Nemotron-3_5-Lightning at https://api.tokenfactory.nebius.com/v1/. Make endpoints and aliases configurable. Never silently substitute another memory model.

Keep secrets in operator-managed ignored environment files. Run pnpm check and relevant synthetic demonstrations after behavioral changes. Record actual outcomes and current limitations in docs/HANDOFF.md. Configuration is not proof of execution. Native containers, local GPU inference and installed MCP hosts still need validation. Choose the OSS license before publication.

## Codex Cloud

Read docs/CODEX_CLOUD.md for environment preparation. Use Node.js 24 and the packageManager pin pnpm@11.25.0. The Install script is bash scripts/codex-cloud-setup.sh. Baseline pnpm check and pnpm demo use synthetic fixtures and PGlite, and require no provider credentials, external database, Docker, Executor or GPU. Keep that baseline usable as optional retrieval features are added. For disposable browser review after the build, use pnpm dev:demo. Record native PostgreSQL/pgvector, container and real-provider checks separately; do not report them as passed from fixture tests. Start services only when the task needs them and the required configuration exists.

## Cursor Cloud Agents

The Cloud Agent install puts Node.js 24.21.0 on `/opt/node-v24.21.0` and activates pnpm 11.25.0, then runs `pnpm install --frozen-lockfile`. Login shells prepend that Node so it is selected ahead of any older `node` already on `PATH`. `pnpm check` and `pnpm demo` remain the credential-free baseline. Run `pnpm dev:demo` only for browser review; it serves `http://127.0.0.1:3000` with `demo@example.invalid` / `threadkeeper-demo-password` and drops its database on exit. Do not start the API or worker without an operator database.
