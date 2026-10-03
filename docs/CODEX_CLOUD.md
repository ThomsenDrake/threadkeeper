# Codex Cloud development

The repository supports a credential-free development baseline on Node.js 24 with pnpm 11.25.0. The install script installs the frozen workspace dependencies, runs type checking, the test suite and the React production build, then runs the synthetic correction/deletion demonstration. It starts no persistent service and creates no operator account.

```bash
bash scripts/codex-cloud-setup.sh
```

No Nebius key, OpenAI API key, Executor instance, Docker daemon, external database or GPU is required for these checks. Database tests use PGlite. Native PostgreSQL/pgvector, container builds and local GPU inference require separate validation. Passing this script locally is not evidence of a completed Codex Cloud setup or task.

Local verification on 2026-10-03: the full script passed on Node.js 24.19.0 with the existing pnpm 11.25.0, including 22 tests, type checking, the production build and the synthetic lifecycle demo. Shell syntax and whitespace checks passed. Environment creation and execution in Codex Cloud remain to be verified.

## Create the environment

Use the private [ThomsenDrake/threadkeeper](https://github.com/ThomsenDrake/threadkeeper) GitHub repository. In ChatGPT, choose **Work in > Cloud > Select environment > Create environment**, select the repository and **Get started**. The alternative entry point is **Settings > Codex Cloud > Environments > Create environment**. Supply the setup request below, review the results, save and **Publish**. Start a new task after **Environment published** appears.

Setup request:

```text
Prepare this repository for Threadkeeper development. Use Node.js 24 and the
packageManager pin pnpm@11.25.0. Record bash scripts/codex-cloud-setup.sh as the
Install script. Run it and report the actual result. Use package-manager network
access for public dependencies. Do not require provider credentials, Docker,
Executor or a GPU for the baseline. Keep the environment private.

For the Start skill, record instructions to read AGENTS.md and docs/HANDOFF.md,
then run pnpm check and pnpm demo when validating changes. Start pnpm dev:demo
only when browser review is needed. Do not start the production API or worker
without an operator database and configuration.
```

The current Cloud interface records an **Install script** for preparing dependencies and a **Start skill** for startup instructions. The latter is an environment field; this repository does not install or require a separate packaged skill. Runtime installation is part of environment preparation. The script verifies Node.js 24 and fails clearly if the selected runtime differs. It uses the existing pinned pnpm, otherwise Corepack, otherwise an exact npm installation. It does not upgrade to `latest` or rewrite `package.json`.

Changes to a reusable environment require review and **Republish**; verify them in a new task. Existing tasks retain their own saved state. Commit useful code changes to GitHub. Environment state does not replace source control.

## Work without provider credentials

Run `pnpm check` for the baseline and `pnpm demo` for the synthetic walkthrough. For a disposable browser profile, run `pnpm dev:demo` after the build. It binds to `127.0.0.1:3000` and prints synthetic sign-in credentials. Its database disappears when the process exits. Use these fixtures when reviewing the profile, never personal exports.

Provider integration is an optional, separately configured task. The default memory model is `nvidia/Nemotron-3_5-Lightning` through Nebius Token Factory; a local compatible endpoint is configurable. See [provider verification](PROVIDER_VERIFICATION.md) and [self-hosting instructions](../README.md). Baseline tests must continue to run with provider settings absent.

## Suggested first development task

Hybrid recall is a useful next product increment because the current service uses full-text and substring retrieval, while its embedding adapter is not connected to recall. Native deployment validation remains a separate acceptance item when an appropriate runtime is available.

```text
Read AGENTS.md, README.md, docs/MVP_BRIEF.md, docs/DECISIONS.md and docs/HANDOFF.md.
Run pnpm check and pnpm demo first and record their actual results.

Implement optional hybrid full-text/vector recall in the existing memory layer.
Inspect the provider adapter, schema and authorization paths before changing them.
Keep explicit capture and client-invoked recall, and keep the credential-free
full-text baseline working. Make embedding dimensions configurable and verify
pgvector limits before choosing an index. Preserve owner/project permissions,
active revisions, source evidence and inference labels in every retrieval path.
Corrections must exclude older records and deletion must remove embeddings and
derived results as well as lexical search results. Add meaningful deterministic
tests using synthetic embeddings, including permission boundaries and the central
capture/correct/delete demonstration. Record native pgvector validation separately
if this runtime cannot run it. Run pnpm check and pnpm demo after the change.
Update docs/HANDOFF.md with evidence and remaining limits. Do not deploy, change
DNS, require Executor, add a general assistant or add paid feature gates.
```

## Verified documentation

Checked 2026-10-03 against primary documentation:

- [Current Cloud environment guide](https://learn.chatgpt.com/docs/environments/cloud-environments): repository selection, installation/startup fields, publication and saved state.
- [Codex Cloud overview](https://learn.chatgpt.com/docs/cloud): environment preparation and starting a task.
- [Corepack](https://github.com/nodejs/corepack): `packageManager` pins, `corepack enable` and `corepack install`.
- [pnpm installation](https://pnpm.io/installation): Node.js 24 supports pnpm 11. The repository deliberately retains its exact version.

The old singular `cloud-environment` guide is marked **Legacy** and describes a different setup and caching flow. Use the current guide above for development tasks.
