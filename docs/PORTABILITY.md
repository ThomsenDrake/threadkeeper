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

Import through the signed-in owner's Portability screen or `POST /api/import`. The authenticated destination owner becomes the owner; imported provenance keeps its original IDs. The server validates schema version, duplicates, checksums, quotations, attribution, scopes, revision sequences and authoritative correction/confirmation evidence in a transaction. Confirmed and dismissed candidate histories remain distinct from their original model interpretations. Revision provider identities are optional in older v1 bundles; missing identities remain unknown, rather than being reconstructed. Active inferred/proposed records cannot bypass explicit confirmation through import.

Tombstones are applied before content admission. Sources or memories matching known deletions are skipped. Incoming new deletion history requires a fresh destination if existing source content could conflict; the service returns `fresh_import_required` rather than silently assuming it has scrubbed old data. Identical existing deletion history can be replayed. Conflicting stable IDs/content return explicit import conflicts. Each import is atomic: validation or a conflict commits no import records, even when earlier rows in the same bundle were new. A successful response and the profile separately report newly imported, already-present and excluded source/memory counts. Exclusions distinguish sources blocked by deletion history, memories blocked by their scoped content tombstones, and memories whose supporting evidence was excluded. These exclusion categories are disjoint; a memory with excluded evidence is counted in that category first. Deletion-marker counts are reported separately. The JSON request limit is 12 MiB; the profile checks file size before reading and keeps failed valid files selected for a deliberate retry. An interrupted connection is an unknown completed outcome; refresh records before retrying. Identical reimports are safe and count existing records instead of new records.

Fresh-database synthetic round-trip assertions preserve remaining sources, evidence and revisions. A disposable native PostgreSQL/pgvector hybrid round-trip also passed; full application-container portability and backup restore remain to be exercised. This format is an initial versioned contract, not a completed broad chatbot-export importer.

## Correction and deletion limits

Corrections preserve prior revisions as superseded history, add direct user correction evidence and block old supporting sources from extraction. Current retrieval returns the corrected revision. The current reconciliation prevents exact obsolete statements from being reintroduced; robust semantic conflict detection is incomplete.

Forgetting starts with an owner-only preview of the complete removal impact. Memory confirmation requires its observed revision and the preview hash; source confirmation requires the preview hash. The server recomputes the graph under the owner lock and rejects a changed impact with HTTP 409 before creating tombstones or deleting anything. The hash binds the owner, target, source content/identities, current memories, complete revisions/evidence and affected job membership. Unrelated owner changes and transient job progress do not invalidate an unchanged impact.

Deletion traverses every historical source/evidence link, same normalized memory assertions within project/subject, and known normalized source-content copies throughout the owner. It removes the whole connected group of memories, revisions and sources, including sibling interpretations and sources awaiting extraction. Identical raw copies are included even when neither has a memory yet, so another queued copy cannot recreate forgotten content. Because source-content tombstones apply throughout the owner, this control requires unrestricted owner access.

Every extraction job referring to an affected source is removed in full. Any other surviving sources in that job are retained but not automatically requeued; the preview lists both the job's original source IDs and the affected subset. In-flight workers recheck the job/source state before committing and cannot restore the deleted graph. Generated full-text indexes and any optional embedding rows follow canonical record deletion. The slice has no generated summary or retrieval cache subsystem.

Non-content tombstones prevent replay of known event identities, normalized source content and known memory statements in their scope. They do not constitute a semantic classifier able to recognize every rewritten assertion. Retained exports, database backups, provider-retained copies and already delivered client context remain separate copies; deletion in the active service does not erase them.

## Backup, deletion ledgers and isolated restore

The Compose database uses the `postgres_data` named volume. Owner exports are portable application snapshots; they exclude authentication and operational state. An operator-managed PostgreSQL backup preserves the whole installation, including password hashes and client grants. Keep archives and deletion ledgers private and apply an expiry policy to retained copies.

For a consistent maintenance backup, stop API and worker writes and use a compatible PostgreSQL client. A custom-format example is:

```sh
mkdir -p backups
docker compose --env-file .env -f deploy/compose.yaml stop api worker
docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U threadkeeper --format=custom --exclude-schema=tk_recovery threadkeeper \
  > backups/threadkeeper.dump
```

`backups/` and `.env.*` are ignored. Encrypt copies according to the operator's storage policy. The backup command above is an operator example; it is not evidence of a production backup.

**An older archive can contain information forgotten after its creation.** Keep a newer deletion ledger separately from each archive. The signed-in owner can download it from Import & export or `GET /api/deletion-ledger`; client credentials cannot download it. Its strict `threadkeeper.deletion-ledger.v1` contract contains `owner_id`, `exported_at`, `snapshot_version`, and deletion kind/hash/date rows, without source text, memory statements, credentials or grants. Hashes remain private metadata. A ledger covers known deletions at export time, not unknown later deletions.

With services stopped, an operator can export the final ledger directly from the current database. Use the stable owner ID from the owner download; repeat for every canonical owner and every restored account, including accounts without captured context, in a multi-owner database. The output file must not already exist.

```sh
node --env-file=.env --import tsx deploy/deletion-ledger.ts \
  --owner OWNER_ID --output backups/deletions-newer.json
```

The supported recovery target is a **new, distinct, empty PostgreSQL database** named `tk_restore_` followed by lowercase letters, numbers or underscores (at most 63 characters in total). Keep it isolated; do not point services or other SQL clients at it while recovering. Install compatible `pg_restore` locally and create the empty database with the operator's PostgreSQL administration tools. The application container does not include PostgreSQL client binaries. `THREADKEEPER_PG_RESTORE` can select an operator-managed executable path, including a wrapper for an isolated PostgreSQL container.

Create an ignored private `.env.restore` with:

```dotenv
DATABASE_URL=postgresql://OPERATOR:PRIVATE_PASSWORD@localhost:5432/threadkeeper
RESTORE_DATABASE_URL=postgresql://OPERATOR:PRIVATE_PASSWORD@localhost:5432/tk_restore_recovery
RESTORE_PASSWORDS_FILE=backups/restore-passwords.json
```

`DATABASE_URL` names the ordinary installation and is used only to reject an accidentally identical target; recovery never connects through it. `RESTORE_DATABASE_URL` must name the explicit target and cannot fall back to ordinary configuration. This initial flow supports the public application schema and an explicit PostgreSQL URL with optional `sslmode`; custom search paths and other URL options are rejected.

In `RESTORE_PASSWORDS_FILE`, privately supply a JSON object mapping **every restored account's exact owner ID** to a new password of 12–1024 characters. Use mode 0600 and delete this file after successful promotion. This reset is mandatory because an old archive may otherwise restore an obsolete password. Passwords never enter recovery arguments or logs.

```sh
node --env-file=.env.restore --import tsx deploy/restore.ts \
  --target-db tk_restore_recovery --backup backups/threadkeeper.dump \
  --ledger backups/deletions-newer.json
node --env-file=.env.restore --import tsx deploy/recovery-status.ts
```

Repeat `--ledger` for additional owners. Coverage must match the restored canonical owner and account IDs exactly; recovery does not infer an owner mapping from email. Ledger snapshots older than restored owner snapshots are rejected.

The command checks the actual database name, emptiness and other connections, then holds an exclusive database advisory lock and commits a pending marker in `tk_recovery`. It streams the archive to `pg_restore` with one transaction, excludes the marker schema, and verifies that the streamed bytes match the recorded archive digest. It runs current migrations and applies incoming plus restored tombstones before any service can start. The same connected deletion graph as owner forgetting includes duplicate normalized sources, sibling interpretations and every correction/confirmation revision. Affected jobs, sources, memories, evidence, history and vectors disappear together. Reconciliation verifies the remaining canonical rows before committing completion.

All restored client grants are revoked, sessions are cleared, and account passwords are replaced in the same completion transaction. Sign in with the new password and reconnect each client explicitly after promotion. Original client IDs remain provenance only. Remaining embeddings can be rebuilt using the same configured local or hosted embedding adapter; recovery itself calls no provider.

API, worker, standalone migrations and reindexing hold shared advisory locks and reject incomplete recovery state. API readiness and HTTP/MCP routes also return `recovery_incomplete` while the marker is incomplete. Missing recovery markers allow normal fresh and legacy installations. A manual raw restore that bypasses this utility is unsupported: the application cannot infer that an arbitrary unmarked database came from an old archive.

### Failures and promotion

Archive, migration, owner-coverage, password-reset and reconciliation failures leave the target gated. SQL purge failures roll back all owners together. Retry with the same archive and ledgers; their digests bind the pending run. Successfully restored targets can resume reconciliation. A crash after archive commit but before the restored-phase marker is recorded creates an intentionally ambiguous target: `recovery_restore_ambiguous` requires discarding that isolated target and starting with another empty database. Do not manually mark it complete. A completed identical run returns `already_complete`.

Only after the status is `complete`, point API/worker `DATABASE_URL` at the recovered target, start them, and verify health, sign-in, remaining profile records and authorized recall. Keep the old database and archive isolated under the retention policy. The newer ledger preserves forgetting; it does not reconstruct later captures, corrections, password changes or any other state absent from the old backup. Previously downloaded exports, backups, provider-retained copies and delivered client context remain separate copies.

Credential-free PGlite binary-snapshot tests restore older synthetic data and prove that newer tombstones remove duplicate sources, corrected/confirmed/dismissed histories, jobs, vectors and export content, while another owner survives. Native archive execution is separately exercised by `pnpm recovery:demo`; this Docker-only harness creates disposable synthetic PostgreSQL databases and uses actual `pg_dump`/`pg_restore`, without providers or operator data.

## Self-hosted inference and embeddings

All application services and authentication are locally configurable. Replace `MODEL_BASE_URL`/`MODEL_ID` with a compatible operator-run inference server and remove Nebius credentials. Configure `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` for an OpenAI-compatible local embedding endpoint; no hosted account is required. See [retrieval setup](RETRIEVAL.md). A different embedding model or preprocessing requires a complete reindex, not mixed comparison with old vectors.

NVIDIA's published Lightning recipes provide a starting point; no local GPU recipe has been validated by this project. Pin the runtime image digest, model revision and embedding preprocessing after the hardware run. Test that the same profile/MCP flow runs without Threadkeeper/Nebius accounts and with external control-plane access disabled after setup downloads. This is a mandatory feature-parity gate, not a paid upgrade.

## Supported upgrades

SQL setup now has a checksum migration ledger (`tk_schema_migrations`). Under one transaction and advisory lock, the runner adopts the existing rerunnable setup once, then applies only pending ordered scripts. A changed recorded script, missing intermediate ledger entry or unknown future migration fails startup. Historical scripts remain unchanged; ship a new numbered migration for a schema change. Optional pgvector must be available when its initial setup runs; install it before the first migration, or use a fresh vector-enabled destination for portable import.

Before upgrading, stop API/worker, retain a consistent backup and a current deletion ledger, and exercise the new revision on an isolated copy with the restore procedure above. Then run the same migration command against the intended stopped installation:

```sh
node --env-file=.env --import tsx deploy/migrate.ts
```

The API also migrates before listening. Keep worker and API on the same application revision. Migration SQL and ledger recording commit atomically; a failed upgrade preserves the prior schema and ledger. There is no automatic down-migration. The recovery utility applies the migrations shipped with its own application revision; it does not produce an older schema for an older binary. A binary rollback after a committed schema upgrade is unsupported unless that release explicitly validates compatibility. Recover using a compatible application revision and the newest available deletion ledgers, after rehearsing the isolated procedure. Never rewrite a historical migration or bypass a checksum failure to force an older binary to run against a newer schema.
