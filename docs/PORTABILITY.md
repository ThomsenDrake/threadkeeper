# Portability and operations

## Export v1

The owner profile downloads JSON with `schema_version:"threadkeeper.export.v1"` and:

| Field | Contents |
| --- | --- |
| `exported_at` | Export timestamp |
| `sources` | Stable source/event/client identifiers, scope, original text and author/origin/capture labels, dates, checksum and extraction block state |
| `memories` | Remaining current records, kind, scope, origin/status, revision, authority, dates and extractor identity |
| `evidence` | Exact quotations linking source IDs to individual memory revisions |
| `revisions` | Remaining memory correction history and editor-client identifiers |
| `tombstones` | Non-content deletion identities/hashes and deletion dates |

The export excludes credentials, sessions, passwords, client grants, jobs and embedding indexes. A client ID in provenance is historical metadata, not an active access grant. Embeddings are rebuildable. The optional worker or `pnpm reindex` regenerates current embeddings after import using the destination embedding configuration. Full-text retrieval is immediately available.

## Import behavior

Import through the signed-in owner's Portability screen or `POST /api/import`. The authenticated destination owner becomes the owner; imported provenance keeps its original IDs. The server validates schema version, duplicates, checksums, quotations, attribution, scopes, revision sequences and authoritative correction evidence in a transaction.

Tombstones are applied before content admission. Sources or memories matching known deletions are skipped. Incoming new deletion history requires a fresh destination if existing source content could conflict; the service returns `fresh_import_required` rather than silently assuming it has scrubbed old data. Identical existing deletion history can be replayed. Conflicting stable IDs/content return explicit import conflicts.

Fresh-database synthetic round-trip assertions preserve remaining sources, evidence and revisions. A disposable native PostgreSQL/pgvector hybrid round-trip also passed; full application-container portability and backup restore remain to be exercised. This format is an initial versioned contract, not a completed broad chatbot-export importer.

## Correction and deletion limits

Corrections preserve prior revisions as superseded history, add direct user correction evidence and block old supporting sources from extraction. Current retrieval returns the corrected revision. The current reconciliation prevents exact obsolete statements from being reintroduced; robust semantic conflict detection is incomplete.

Deletion traverses connected source/evidence records and removes the whole connected group of memories, revisions and sources. Pending jobs referring to affected sources are removed and in-flight workers recheck the job/source state before committing. Generated full-text indexes and any optional embedding rows follow canonical record deletion. The slice has no generated summary or retrieval cache subsystem.

Non-content tombstones prevent replay of known event identities, normalized source content and known memory statements in their scope. They do not constitute a semantic classifier able to recognize every rewritten assertion. Retained exports, database backups, provider-retained copies and already delivered client context remain separate copies; deletion in the active service does not erase them.

## Backup and restore

The Compose database uses the `postgres_data` named volume. Owner exports are useful portable snapshots, but they do not back up authentication, all operational state or the whole installation.

For an operator-managed database backup, stop the worker while taking a consistent maintenance snapshot if necessary, keep the backup private and set a retention/expiry policy. A PostgreSQL custom-format example is:

```sh
mkdir -p backups
docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U threadkeeper --format=custom threadkeeper > backups/threadkeeper.dump
```

This command is documented, not executed in the development environment. `backups/` must stay out of version control. Encrypt backups according to the operator's storage policy.

**An old backup may contain information deleted after its creation.** There is no automatic restore reconciliation in this starter. Restore into an isolated new database, keep the API and worker stopped, and reconcile the current deletion state before making it active. A recent export's tombstones cannot simply be imported into a nonempty restored database, because the current importer rejects that unsafe merge. A restore-safe purge/reconciliation utility and its acceptance tests remain required work.

Until that utility is implemented, a supported application-level migration is to export the current remaining data and import it into a fresh instance. If only an old backup survives and later tombstones are unavailable, the service cannot reconstruct the later deletion history. Do not advertise that it can.

## Self-hosted inference and embeddings

All application services and authentication are locally configurable. Replace `MODEL_BASE_URL`/`MODEL_ID` with a compatible operator-run inference server and remove Nebius credentials. Configure `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` for an OpenAI-compatible local embedding endpoint; no hosted account is required. See [retrieval setup](RETRIEVAL.md). A different embedding model or preprocessing requires a complete reindex, not mixed comparison with old vectors.

NVIDIA's published Lightning recipes provide a starting point; no local GPU recipe has been validated by this project. Pin the runtime image digest, model revision and embedding preprocessing after the hardware run. Test that the same profile/MCP flow runs without Threadkeeper/Nebius accounts and with external control-plane access disabled after setup downloads. This is a mandatory feature-parity gate, not a paid upgrade.

## Upgrade state

The API currently applies rerunnable SQL setup files on startup. There is no versioned migration ledger or tested rollback process yet. Back up the database, validate future migrations on a copy and preserve deletion state before upgrading. Operational polish, recovery tooling and restore correctness must be delivered alongside the public service.
