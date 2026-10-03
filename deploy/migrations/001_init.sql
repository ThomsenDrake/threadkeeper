CREATE TABLE IF NOT EXISTS tk_owners (
  id text PRIMARY KEY,
  snapshot_version bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tk_sources (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES tk_owners(id),
  client_id text NOT NULL,
  event_id text NOT NULL,
  project_id text,
  subject text NOT NULL,
  text text NOT NULL,
  author_role text NOT NULL CHECK (author_role IN ('user','assistant','system','unknown')),
  origin text NOT NULL CHECK (origin IN ('user_explicit','user_confirmed','assistant_proposed','agent_reported','inferred')),
  capture_method text NOT NULL CHECK (capture_method IN ('explicit_capture','client_summary','profile_entry','profile_correction','import')),
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL,
  extraction_blocked boolean NOT NULL DEFAULT false,
  UNIQUE (owner_id, client_id, event_id)
);
CREATE INDEX IF NOT EXISTS tk_sources_scope ON tk_sources(owner_id, project_id, subject);
CREATE TABLE IF NOT EXISTS tk_memories (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES tk_owners(id),
  project_id text,
  subject text NOT NULL,
  statement text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact','preference','decision','constraint','project_state')),
  origin text NOT NULL CHECK (origin IN ('user_explicit','user_confirmed','assistant_proposed','agent_reported','inferred')),
  status text NOT NULL CHECK (status IN ('candidate','active','disputed','superseded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  authoritative boolean NOT NULL DEFAULT false,
  effective_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  extractor text,
  content_key text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED,
  UNIQUE (owner_id, content_key)
);
CREATE INDEX IF NOT EXISTS tk_memories_scope ON tk_memories(owner_id, project_id, subject, status);
CREATE INDEX IF NOT EXISTS tk_memories_search ON tk_memories USING gin(search_vector);
CREATE TABLE IF NOT EXISTS tk_revisions (
  memory_id text NOT NULL REFERENCES tk_memories(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  statement text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL,
  effective_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  editor_client_id text NOT NULL,
  PRIMARY KEY (memory_id, revision)
);
CREATE TABLE IF NOT EXISTS tk_evidence (
  memory_id text NOT NULL,
  revision integer NOT NULL,
  source_id text NOT NULL REFERENCES tk_sources(id) ON DELETE CASCADE,
  quote text NOT NULL,
  PRIMARY KEY (memory_id, revision, source_id),
  FOREIGN KEY (memory_id, revision) REFERENCES tk_revisions(memory_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tk_evidence_source ON tk_evidence(source_id);
CREATE TABLE IF NOT EXISTS tk_captures (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES tk_owners(id),
  client_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, client_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS tk_jobs (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES tk_owners(id),
  client_id text NOT NULL,
  project_id text,
  subject text NOT NULL,
  source_ids text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','complete','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  result jsonb
);
CREATE INDEX IF NOT EXISTS tk_jobs_pending ON tk_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS tk_tombstones (
  owner_id text NOT NULL REFERENCES tk_owners(id),
  kind text NOT NULL CHECK (kind IN ('source_identity','source_content','memory_content')),
  hash text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, kind, hash)
);
-- Vector storage is optional until a real embedding provider has been validated.
-- No vector dimension is assumed. The first loop uses PostgreSQL full-text search.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS tk_embeddings (
      memory_id text PRIMARY KEY REFERENCES tk_memories(id) ON DELETE CASCADE,
      revision integer NOT NULL,
      provider_model text NOT NULL,
      preprocessing_version text NOT NULL,
      embedding vector NOT NULL
    );
  END IF;
END $$;
