# Codex Cloud development

The repository supports a credential-free development baseline on Node.js 24 with pnpm 11.25.0. The install script installs the frozen workspace dependencies, runs type checking, the test suite and the React production build, then runs the synthetic correction/deletion demonstration. It starts no persistent service and creates no operator account.

```bash
bash scripts/codex-cloud-setup.sh
```

No Nebius key, OpenAI API key, Executor instance, Docker daemon, external database or GPU is required for these checks. Database tests use PGlite. Native PostgreSQL/pgvector, container builds and local GPU inference require separate validation. Passing this script locally is not evidence of a completed Codex Cloud setup or task.

Local verification on 2026-10-03: the full script passed on Node.js 24.19.0 with the existing pnpm 11.25.0, including 22 tests, type checking, the production build and the synthetic lifecycle demo. Shell syntax and whitespace checks passed. A subsequent Cloud task on 2026-10-03 verified the baseline and hybrid increment; see [actual results](HANDOFF.md). The task initially resolved the environment fallback pnpm 11.19.0. A writable Corepack shim selected the pinned 11.25.0 without changing the repository pin:

```sh
mkdir -p /tmp/threadkeeper-bin
corepack enable --install-directory /tmp/threadkeeper-bin pnpm
PATH=/tmp/threadkeeper-bin:$PATH corepack install
PATH=/tmp/threadkeeper-bin:$PATH pnpm check
PATH=/tmp/threadkeeper-bin:$PATH pnpm demo
```

The writable shim was needed because `corepack enable pnpm` could not write the system Node directory. The reusable Install script itself has not been changed or republished by this task.

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

Provider integration is an optional, separately configured task. The default memory model is `nvidia/Nemotron-3_5-Lightning` through Nebius Token Factory; a local compatible endpoint is configurable. See [provider verification](PROVIDER_VERIFICATION.md), the customer run steps in [README.md](../README.md), and the host-run and check commands in [DEVELOPMENT.md](DEVELOPMENT.md). Baseline tests must continue to run with provider settings absent.

## Continue after hybrid recall

Optional hybrid recall is now implemented. [Retrieval setup](RETRIEVAL.md) covers provider configuration, dimensions, exact ranking, reindexing and fallback behavior. `pnpm check` and `pnpm demo` remain credential-free; vector tests use the pinned PGlite pgvector extension and synthetic embeddings.

For a separately provisioned **disposable synthetic** native database, install pgvector in its public schema, then opt in explicitly:

```sh
# Export THREADKEEPER_NATIVE_TEST_URL securely for the disposable database first.
node --import tsx --test tests/hybrid.test.ts tests/api-hybrid.test.ts
pnpm demo
```

The helper creates and drops isolated test schemas. Only vector-enabled fixtures use the native URL; the explicit no-pgvector fallback and ordinary full-text fixtures remain PGlite. Do not point this at an operator or production database. Native checks that actually ran, exact server/extension versions and remaining full-stack limitations are recorded in [HANDOFF.md](HANDOFF.md).

For full application containers with native PostgreSQL/pgvector and synthetic provider HTTP, run `pnpm integration`. It generates disposable credentials/resources and cleans them up; see [integration requirements and evidence boundaries](INTEGRATION.md). In this managed environment the runner passes `CODEX_PROXY_CERT` as an optional BuildKit secret, preserving TLS verification. This does not change the reusable environment settings.

Next work should measure the chosen embedding model's query preprocessing and retrieval quality and validate installed MCP hosts and local GPU inference. Keep provider credentials optional for baseline development and keep native/GPU/provider claims separate from fixture results.

## Verified documentation

Checked 2026-10-03 against primary documentation:

- [Current Cloud environment guide](https://learn.chatgpt.com/docs/environments/cloud-environments): repository selection, installation/startup fields, publication and saved state.
- [Codex Cloud overview](https://learn.chatgpt.com/docs/cloud): environment preparation and starting a task.
- [Corepack](https://github.com/nodejs/corepack): `packageManager` pins, `corepack enable` and `corepack install`.
- [pnpm installation](https://pnpm.io/installation): Node.js 24 supports pnpm 11. The repository deliberately retains its exact version.

The old singular `cloud-environment` guide is marked **Legacy** and describes a different setup and caching flow. Use the current guide above for development tasks.
