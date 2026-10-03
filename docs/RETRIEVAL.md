# Optional hybrid recall

Without `EMBEDDING_MODEL`, search uses PostgreSQL full-text matching plus the existing substring fallback. Capture, correction, deletion, browsing, export/import and the synthetic checks require no provider credentials. Empty queries browse canonical records and make no embedding request.

## Configure and rebuild

Use the same embedding settings in the API, worker and rebuild command. Keep keys in an ignored operator-managed environment file. A self-hosted OpenAI-compatible endpoint can omit the key entirely:

```dotenv
EMBEDDING_BASE_URL=http://localhost:8080/v1/
EMBEDDING_MODEL=your-pinned-embedding-alias
EMBEDDING_DIMENSIONS=4096
EMBEDDING_API_KEY=
EMBEDDING_TIMEOUT_MS=60000
```

The dimension is required for runtime hybrid recall, must be between 1 and 16000, and is sent as `dimensions` in the embeddings request. Choose a dimension your server supports and measure its output. Providers that do not accept this OpenAI-compatible request shape need an adapter change; no dimension reduction or model substitution happens silently. A distinct embedding endpoint never inherits the memory-model API key. Model extraction remains separately configured, with the existing Nemotron default.

Install pgvector in the PostgreSQL server and run the application migrations. When the extension is available, migrations create the optional vector table and lifecycle trigger. They remain rerunnable without pgvector. After installing an extension or changing schema/configuration, restart API and worker: capability detection is cached per process.

The worker indexes missing or mismatched current active/candidate memories in bounded batches. To complete a rebuild independently of extraction, run:

```sh
node --env-file=.env --import tsx deploy/reindex.ts
# Or, with the environment already exported:
pnpm reindex
```

The command requires `DATABASE_URL`, embedding configuration and compatible pgvector storage. It reports counts and sanitized failure status, exits nonzero on failure and resumes missing work on a later run. Existing full-text search remains available while indexing catches up. Corrected statements are immediately available lexically; their semantic matches become available after reindexing. Imported memories follow the same process. Export bundles exclude embeddings.

An embedding space is identified by endpoint, model alias, dimensions and the versioned text/vector preprocessing. Switching any component makes old vectors ineligible for recall and the worker replaces them. Stop workers with old settings before switching, and keep API/worker settings aligned. Use a new pinned model alias when changing weights behind a self-hosted endpoint: the service cannot detect an invisible change behind an unchanged alias. There is one derived embedding per memory, so simultaneous model configurations are not supported.

## Ranking and correctness

The API validates read permission and requested project scope before requesting a query embedding. Owner, project, subject, originating source/client and status filters define one database relation shared by both ranking paths. Clients with project grants can also read the existing global (`project_id IS NULL`) context. Inferences and assistant proposals retain their candidate status and attribution until explicit owner review. Confirmation creates an active `user_confirmed` current revision with separate evidence; dismissal retains a `dismissed` record. Default recall returns active records. Explicit status filters still allow inspecting other states.

Lexical ranking keeps full-text and substring matches. Vector ranking computes exact cosine similarity over compatible, current-revision embeddings in the filtered relation. Each path contributes up to four times the requested result limit. Reciprocal-rank fusion adds `1 / (60 + rank)` from each path, deduplicates memory IDs and applies the final limit. Vector-only candidates must meet a cosine threshold of 0.3; this is an initial heuristic, not a calibrated quality guarantee. Nonfinite similarities are excluded. A semantic query about an old deadline may return its corrected statement because the topic still matches; it must never return the obsolete statement as current context.

Source evidence comes from the current memory revision, independently of ranking. User corrections remain authoritative and require no model approval. A database trigger deletes embeddings on statement, revision or status changes. Deletion cascades to embeddings along with the existing connected source/memory cleanup. An embedding call runs outside database locks, and its commit checks owner, memory existence, revision, statement and status again under the owner lock. In-flight output cannot recreate corrected or deleted vectors. There is no derived summary or retrieval cache to invalidate.

Every vector is validated and normalized to unit length before storage or querying; this avoids float32 norm overflow producing invalid cosine scores. The runtime probes the installed extension with a synthetic vector at the configured dimension before using exact ranking. **No ANN index is created.** Native PostgreSQL 17.11 with pgvector 0.8.7 accepted exact cosine at 4096 and 16000 dimensions; both HNSW and IVFFlat `vector_cosine_ops` indexes rejected dimensions above 2000. Approximate indexing needs a separate measured design, especially for scoped results.

## Coverage and limits

Results keep their source evidence, origin, status and revision. `coverage.retrieval` identifies `postgresql_full_text` or `postgresql_hybrid`. `coverage.semantic_search` explains whether semantic recall was enabled, not configured, not requested for an empty query, unavailable because of provider failure, or disabled by a capability/storage check. Provider failures do not block fresh lexical recall, and later requests retry the provider. Hybrid coverage means the query path ran; it does not promise every eligible memory has already been embedded.

Exact ranking scans the authorized vector set and has not been load-tested for large personal archives. Each nonempty hybrid query adds a provider round trip, bounded by its configured timeout. Index workers do not have durable embedding attempt leases or exponential backoff: multiple workers can duplicate inference, although transactional admission protects canonical state. A malformed batch can block subsequent indexing until the provider/data issue is resolved. All embedding requests send statement/query text to the operator's selected endpoint; use a self-hosted endpoint for local processing.

Synthetic vectors test permissions, filtering, ranking and lifecycle behavior. They do not demonstrate real-provider semantic quality. `pnpm integration` exercises native pgvector, application containers and the actual worker/provider HTTP adapters with a deterministic synthetic fixture; see [the harness](INTEGRATION.md). Model-specific instruction prefixes, retrieval evaluation, reranking, paraphrase conflict reconciliation and full local GPU inference remain separate work. See [handoff results](HANDOFF.md) for what actually ran.
