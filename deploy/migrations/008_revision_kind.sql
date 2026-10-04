-- Kind was immutable before this migration, so each historical revision has
-- the memory's original kind. Preserve known kinds when the setup is rerun.
ALTER TABLE tk_revisions ADD COLUMN IF NOT EXISTS kind text;
UPDATE tk_revisions r SET kind=m.kind FROM tk_memories m
  WHERE r.memory_id=m.id AND r.kind IS NULL;
ALTER TABLE tk_revisions ALTER COLUMN kind SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='tk_revisions'::regclass AND conname='tk_revisions_kind_check') THEN
    ALTER TABLE tk_revisions ADD CONSTRAINT tk_revisions_kind_check
      CHECK (kind IN ('fact','preference','decision','constraint','project_state'));
  END IF;
END $$;
