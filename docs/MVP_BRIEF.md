# Threadkeeper MVP

Status: private MVP development. All six owner/client development outcomes are implemented and merged at feature-delivery main `31befe4`. External release validation and publication decisions remain open, with actual evidence and next steps in [HANDOFF.md](HANDOFF.md). The customer introduction is [README.md](../README.md). Local commands are in [DEVELOPMENT.md](DEVELOPMENT.md). Product requirements come from Drake's request and the attached Threadkeep development brief.

Threadkeeper owns portable personal context for existing chatbots and coding agents. Its profile is the user's control surface. The domain is `threadkeep.si`; the tagline is “Switch agents. Keep the thread.” A general assistant, task manager, and automatic access to every client's conversations are outside scope.

## Central demonstration

Use a synthetic persona and two independent MCP client instances with separate credentials.

1. Client A explicitly saves a project deadline and a writing preference with supporting source events.
2. Client B recalls both without receiving A's transcript directly.
3. The owner signs into the profile, edits the deadline, and deletes the preference.
4. Fresh recalls from both clients return the corrected deadline and omit the deleted preference.

The profile and both clients must use the same canonical PostgreSQL records. Editing does not wait for model approval. Deletion must remove evidence and derived content as well as search results, and pending workers must not restore it. Previously delivered client context remains outside Threadkeeper's control.

## Smallest complete build

| Component | Responsibility |
| --- | --- |
| React profile | Local sign-in, memory search and filters, evidence/revisions, edit/delete, client credentials, import/export |
| Node service | Shared HTTP/OpenAPI and MCP operations, authorization, source persistence, versioned writes, static profile assets |
| Small worker | Bounded source extraction through a configurable model provider, evidence validation, indexing |
| PostgreSQL with pgvector | Owners, clients/scopes, sources, memories, revisions, deletion tombstones, durable jobs and retrieval |
| Provider adapter | Nemotron through Nebius for the hackathon; compatible self-hosted inference and optional embedding endpoints |

Explicit entries can exercise the memory lifecycle before model extraction is available. This is a deterministic functional path, not evidence that the model integration works. When a source requires extraction, capture returns its durable pending state and the worker reports completion or failure.

## Required product behavior

- Recall only authorized owner/project context. Client-provided identifiers cannot select another owner.
- Filter by subject, project, originating source/client, and memory status.
- Preserve source roles, dates, stable IDs, quotations, capture method, and revisions independently from interpretations.
- Label direct statements, user corrections, assistant contributions, agent reports, and inferences distinctly. Deliver every current memory with its origin label; origin is provenance only. All current memories use the same lifecycle without approval.
- Apply revision-checked user corrections authoritatively within matching scope.
- Export a documented versioned bundle with sources, remaining memories, evidence and correction history. Do not export secrets or reactivate access grants.
- Run the same application features with local authentication, inference and embeddings. Managed deployments do not receive exclusive product features.

## Verification gates

The first gate is the central demonstration through real MCP transport and profile HTTP operations. Add focused checks for scope isolation, misattribution, invalid evidence, duplicate capture, concurrent edits, source injection, pending-job deletion and export/import fidelity.

The release gate additionally requires independent existing chatbot/coding-agent integrations, measured provider quality/usage/latency, a fresh-instance import, backup/restore respecting deletion, and the full self-hosted GPU inference flow without Threadkeeper or Nebius accounts. Fresh-instance import and isolated native deletion-aware restore have recorded synthetic acceptance evidence. Learned-provider quality, installed intended hosts and the complete local GPU flow remain open, with missing access and executable next steps in [HANDOFF.md](HANDOFF.md). Container configuration alone does not pass that gate.

## Existing implementation and infrastructure

The private repository now contains the React profile, authenticated HTTP/MCP service, bounded extraction/indexing worker and PostgreSQL/optional pgvector store. Captures and retries, immediate labelled delivery and owner correction, scoped client controls, guarded source/memory forgetting, complete owner pagination/import feedback and isolated deletion-aware recovery work through the canonical database. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) and [HANDOFF.md](HANDOFF.md) record actual merge state and synthetic acceptance evidence; inspect current main and pending PRs before continuing development.

DNS migration is existing user-reported work. This build makes no registrar, Cloudflare, domain, deployment, or paid-resource changes. No public demo is implied by local code or checks.

OSS license, public repository destination, deployment host and hackathon track remain open decisions. Choose the license before publication. Use synthetic demo data and keep private history, employer information and credentials out of the repository.
