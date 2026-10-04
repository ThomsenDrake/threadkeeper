# Disposable full-stack integration

Run the complete application with synthetic data and no provider credentials:

```sh
pnpm install --frozen-lockfile
pnpm integration
```

Use Node.js 24 and pinned pnpm 11.25.0, Docker with a local daemon socket at
`/var/run/docker.sock`, BuildKit, and Compose **2.24.4 or newer** (the overlay uses
`!override` and `!reset`). Initial image and dependency downloads require network
access. The command builds the existing application Dockerfile, then overlays
`deploy/compose.yaml` with disposable settings. It runs native PostgreSQL/pgvector,
the API serving the built React profile, the actual worker process, and a local
OpenAI-compatible HTTP fixture. The profile is served by the API container;
there is no separate profile server.

The runner generates a unique Compose project, image tag, private temporary
environment file and disposable database/owner passwords. PostgreSQL has no
published port; API and fixture use random localhost ports. Fixture controls are
exclusive to this test overlay. Operator `.env` files and provider keys are not
used by this command. The memory-model request retains the exact default
`nvidia/Nemotron-3_5-Lightning` identifier, while the endpoint is explicitly the
synthetic fixture. The embedding alias is `threadkeeper-fixture-embedding-v1`,
with three synthetic dimensions. Neither alias establishes execution of learned
weights or semantic quality.

The harness checks two separately authenticated MCP SDK clients and owner profile
HTTP operations. Client A submits deadline/preference sources without explicit
memories; the worker extracts them through HTTP and indexes embeddings. Client B
recalls both with a query having no lexical match. The owner corrects the deadline
and deletes the preference; fresh recall contains only the correction. Additional
checks cover evidence/inference distinctions, owner/project/client scopes,
permission denials and revocation, provider failures and recovery, model/dimension
validation, and owner edits/deletions while provider replies are held in flight.
Capture-status checks observe processing, failure and completion through HTTP/MCP.
The owner retries failed extraction on the same capture, source and job; an
independent client recalls the resulting memory. Stale retries and token retries
are rejected, receipts remain immutable, and cancelled work cannot restore content.
Owner candidate confirmation/dismissal also runs through HTTP, preserving the original worker inference/source/provider history and proving fresh independent recall uses the separate confirmation evidence. Native SQL inspects jobs and derived vectors; capture, retrieval and profile writes
use application transports. Rerunning migrations is also checked.

Client connection/control checks derive the MCP endpoint from owner settings and
feed its generic endpoint/header object to the independent SDK transports. They
distinguish issuance from observed authentication, reject new profile/client saves
and idempotent replay during owner pause, retain permitted recall, and let an
already admitted queued extraction complete. Stale settings writes fail before
resume, and revoked credentials cannot update their authentication timestamp.
The regression suite opts the existing client-control API fixtures into isolated
native schemas when the runner supplies its disposable database URL. Test totals
come from the actual TAP summary rather than a hardcoded count.

Each stage prints a pass label. A failure exits nonzero with its stage and sanitized
diagnostic logs. A `finally` block removes the project's containers, network,
database volume, generated application image and private credentials, including
after Ctrl-C. Shared downloaded base images and BuildKit cache can remain. The
printed project name identifies resources if Docker itself fails during cleanup;
rerun `docker compose --project-name PROJECT ... down --volumes --remove-orphans`
with the same generated env file while it exists, or remove only resources carrying
that exact Compose project label. Never prune unrelated Docker resources.

In the managed Cloud environment, `CODEX_PROXY_CERT` automatically supplies an
optional BuildKit `proxy_ca` secret. Each dependency-downloading step trusts the
mount without disabling TLS verification or copying the CA into image layers.
On ordinary Docker installations this secret is unnecessary. Preserve Docker's
configured proxy and registry credentials.

## Separate real-provider evidence

The fixture validates application integration, failure behavior and lifecycle
contracts. It does not validate the configured learned model, GPU compatibility,
embedding quality, throughput, latency or installed ChatGPT/Codex host behavior.
`pnpm check` and `pnpm demo` remain independently credential-free and use PGlite.

For an operator-managed provider, keep the selected memory model and embedding
configuration in an ignored environment file and use synthetic inputs:

```sh
node --env-file=.env --import tsx deploy/provider-check.ts
```

This existing probe checks actual provider HTTP responses separately from the
container fixture. To run the application against that provider, use the normal
container command in [README.md](../README.md) with the operator's exact endpoint/alias and
credentials. Host-run API and worker commands are in [DEVELOPMENT.md](DEVELOPMENT.md). A fixture pass does not establish that execution. No provider key or
GPU was available in the current task; see HANDOFF.md for precise observed evidence.
