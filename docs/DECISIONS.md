# Decisions

Date: 2026-10-02 UTC / 2026-10-03 Europe/Paris. User-confirmed requirements take precedence over these implementation choices.

| Decision | Reason and limits |
| --- | --- |
| One TypeScript workspace, React profile, Node API/MCP, small worker | Minimal application boundaries; no general assistant or task execution surface |
| PostgreSQL canonical store; jobs initially in PostgreSQL | Authorization, revisions, deletion and job admission belong in transactional code |
| Shared schema validation | The HTTP and MCP interfaces must enforce the same capture, correction and export contracts |
| Local owner authentication and revocable scoped client tokens | No required cloud identity provider or Threadkeeper account; session/token values are opaque and hashes are stored |
| Separate source events and derived memory | Quotations, author roles and capture method remain inspectable; model interpretation cannot impersonate an original user statement |
| Direct user edits become authoritative source events | The user needs no model approval or external citation to correct their own profile; stale extraction cannot reverse an edit |
| Revision checks on writes | Concurrent profile/client changes must fail explicitly rather than overwrite silently |
| Conservative deletion and non-content tombstones | Delete relevant source/evidence/derived content and block pending extraction/reimport from recreating the forgotten assertion; keep only non-content identifiers/hashes needed for this protection |
| No retrieval cache in the first slice | Fresh reads reflect canonical state without an additional invalidation subsystem |
| Configurable inference and embeddings | Nebius is the hackathon provider, never a runtime dependency for self-hosters |
| Nebius default `nvidia/Nemotron-3_5-Lightning` | Exact identifier verified in official guidance and authenticated model listing; never silently substitute another agent model |
| Prompted JSON with local validation initially | A live JSON-object request succeeded. Truncated schema trial and conflicting Nebius documentation do not establish schema enforcement |
| PostgreSQL full-text retrieval initially | Semantic search is not wired yet. The available Qwen embedding model returned 4,096 dimensions; use measured exact ranking or a validated reduced dimension before adding an ANN index |
| MCP TypeScript v2 | Available package versions are checked by the parent session; modern and legacy client protocol behavior must be tested using the installed code |

## Open decisions and blockers

- **OSS license:** undecided. Do not present the unlicensed starter as a published open-source release.
- **Fully self-hosted model recipe:** required. NVIDIA publishes a pinned vLLM recipe, but this project has not run a GPU/hardware compatibility or feature-parity test. Record image digest, model revision, hardware, throughput, latency and offline steady-state behavior when tested.
- **Existing external clients:** SDK client instances prove transport and server behavior. They do not prove an installed chatbot automatically invokes capture or recall. Validate each intended client and publish concise instructions.
- **Embedding quality:** configurable and rebuildable. Switching model, dimension or preprocessing requires a complete reindex. No quality advantage is claimed.
- **Deletion operations:** ordinary active retrieval is only part of the contract. Test import/restore handling, retained exports, backup expiry and all derived content before advertising a comprehensive forgetting guarantee.
- **Public release/deployment:** no destination selected and no deployment attempted here. Domain setup is already in progress; leave it intact.
