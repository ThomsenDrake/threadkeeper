ALTER TABLE tk_sources DROP CONSTRAINT IF EXISTS tk_sources_capture_method_check;
ALTER TABLE tk_sources ADD CONSTRAINT tk_sources_capture_method_check CHECK (
  capture_method IN ('explicit_capture','client_summary','profile_entry','profile_correction','profile_confirmation','import')
);
ALTER TABLE tk_memories DROP CONSTRAINT IF EXISTS tk_memories_status_check;
ALTER TABLE tk_memories ADD CONSTRAINT tk_memories_status_check CHECK (
  status IN ('candidate','active','disputed','superseded','dismissed')
);
ALTER TABLE tk_revisions ADD COLUMN IF NOT EXISTS extractor text;
-- Historical model metadata cannot be reconstructed once it was cleared by a
-- prior correction. Backfill only the current revision from canonical state.
UPDATE tk_revisions r SET extractor=m.extractor FROM tk_memories m
WHERE r.memory_id=m.id AND r.revision=m.revision AND r.extractor IS NULL AND m.extractor IS NOT NULL;
-- Older sibling supersession retained this flag on inactive records. Authority
-- belongs to the current active owner-authored assertion, not a stale sibling.
UPDATE tk_memories SET authoritative=false WHERE status<>'active' AND authoritative=true;
