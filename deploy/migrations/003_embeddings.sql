-- 001 creates this optional table only when pgvector is available. Running the
-- migrations with no extension must continue to support full-text retrieval.
DO $$ BEGIN
  IF to_regclass('tk_embeddings') IS NOT NULL THEN
    ALTER TABLE tk_embeddings ADD COLUMN IF NOT EXISTS space_id text;
    ALTER TABLE tk_embeddings ADD COLUMN IF NOT EXISTS dimensions integer;
    -- Legacy rows have NULL space/dimensions and cannot participate in recall.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='tk_embeddings'::regclass AND conname='tk_embeddings_dimensions_check') THEN
      ALTER TABLE tk_embeddings ADD CONSTRAINT tk_embeddings_dimensions_check
        CHECK (dimensions IS NULL OR (dimensions > 0 AND dimensions = vector_dims(embedding)));
    END IF;
    EXECUTE $function$
      CREATE OR REPLACE FUNCTION tk_invalidate_embeddings() RETURNS trigger AS $body$
      BEGIN
        IF OLD.revision IS DISTINCT FROM NEW.revision
          OR OLD.statement IS DISTINCT FROM NEW.statement
          OR OLD.status IS DISTINCT FROM NEW.status THEN
          DELETE FROM tk_embeddings WHERE memory_id=NEW.id;
        END IF;
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    $function$;
    DROP TRIGGER IF EXISTS tk_memories_invalidate_embeddings ON tk_memories;
    CREATE TRIGGER tk_memories_invalidate_embeddings
      AFTER UPDATE OF revision,statement,status ON tk_memories
      FOR EACH ROW EXECUTE FUNCTION tk_invalidate_embeddings();
  END IF;
END $$;
-- Memory deletion already removes all embedding rows through ON DELETE CASCADE.
-- Deliberately no ANN index: capability probes verify exact cosine at the
-- configured dimension, including spaces above HNSW/IVFFlat vector limits.
