# Threadkeeper development

Read README.md, docs/MVP_BRIEF.md, docs/DECISIONS.md and docs/HANDOFF.md before architectural changes. Product responsibility is personal context for existing clients through MCP. Do not add a general assistant or task manager.

Preserve source evidence independently from interpretations. Database code owns authorization, current revisions, corrections, deletion and transactions. User profile corrections require no model approval. Never infer acceptance of assistant suggestions from silence. Use synthetic data in demos, tests and recorded provider measurements.

All application features must be self-hostable with no hosted account, license check, telemetry requirement, cloud-only capability or paid feature gate. Exact hackathon default: nvidia/Nemotron-3_5-Lightning at https://api.tokenfactory.nebius.com/v1/. Make endpoints and aliases configurable. Never silently substitute another memory model.

Keep secrets in operator-managed ignored environment files. Run pnpm check and relevant synthetic demonstrations after behavioral changes. Record actual outcomes and current limitations in docs/HANDOFF.md. Configuration is not proof of execution. Native containers, local GPU inference and installed MCP hosts still need validation. Choose the OSS license before publication.

## Codex Cloud

Read docs/CODEX_CLOUD.md for environment preparation. Use Node.js 24 and the packageManager pin pnpm@11.25.0. The Install script is bash scripts/codex-cloud-setup.sh. Baseline pnpm check and pnpm demo use synthetic fixtures and PGlite, and require no provider credentials, external database, Docker, Executor or GPU. Keep that baseline usable as optional retrieval features are added. For disposable browser review after the build, use pnpm dev:demo. Record native PostgreSQL/pgvector, container and real-provider checks separately; do not report them as passed from fixture tests. Start services only when the task needs them and the required configuration exists.
