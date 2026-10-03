-- Derived, non-content attempt state. Canonical memory changes reset retries;
-- deletion/recovery purge them with the memory. Full-text-only setups need no
-- pgvector extension to adopt this migration.
CREATE TABLE IF NOT EXISTS tk_embedding_attempts (
  memory_id text PRIMARY KEY REFERENCES tk_memories(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  space_id text NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  claim_token text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS tk_embedding_attempts_due ON tk_embedding_attempts(next_attempt_at);

CREATE OR REPLACE FUNCTION tk_invalidate_embedding_attempts() RETURNS trigger AS $$
BEGIN
  IF OLD.revision IS DISTINCT FROM NEW.revision
    OR OLD.statement IS DISTINCT FROM NEW.statement
    OR OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM tk_embedding_attempts WHERE memory_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tk_memories_invalidate_embedding_attempts ON tk_memories;
CREATE TRIGGER tk_memories_invalidate_embedding_attempts
  AFTER UPDATE OF revision,statement,status ON tk_memories
  FOR EACH ROW EXECUTE FUNCTION tk_invalidate_embedding_attempts();
