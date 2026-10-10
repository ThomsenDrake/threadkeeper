-- Availability is delivery, not endorsement. Upgrade only current candidates;
-- explicit dismissals and historical interpretations remain out of recall.
DO $$
DECLARE changed_owners text[];
BEGIN
  SELECT array_agg(DISTINCT owner_id) INTO changed_owners FROM (
    SELECT owner_id FROM tk_memories WHERE status='candidate'
    UNION
    SELECT owner_id FROM tk_sources WHERE capture_method='profile_correction' AND origin='user_explicit'
    UNION
    SELECT m.owner_id FROM tk_memories m JOIN tk_evidence e ON e.memory_id=m.id
      JOIN tk_revisions r ON r.memory_id=e.memory_id AND r.revision=e.revision
      WHERE r.origin='user_confirmed' AND NOT EXISTS (
        SELECT 1 FROM tk_evidence re JOIN tk_sources s ON s.id=re.source_id
        WHERE re.memory_id=r.memory_id AND re.revision=r.revision AND s.capture_method='profile_correction'
      )
  ) changed;

  -- A historical confirmation (profile or ordinary capture) was a user assertion.
  -- Its original source metadata stays preserved as captured.
  UPDATE tk_memories m SET origin='user_explicit'
    WHERE m.origin='user_confirmed' AND NOT EXISTS (
      SELECT 1 FROM tk_evidence e JOIN tk_sources s ON s.id=e.source_id
      WHERE e.memory_id=m.id AND e.revision=m.revision AND s.capture_method='profile_correction'
    );
  UPDATE tk_revisions r SET origin='user_explicit'
    WHERE r.origin='user_confirmed' AND NOT EXISTS (
      SELECT 1 FROM tk_evidence e JOIN tk_sources s ON s.id=e.source_id
      WHERE e.memory_id=r.memory_id AND e.revision=r.revision AND s.capture_method='profile_correction'
    );

  UPDATE tk_memories m SET origin='user_confirmed'
    WHERE m.origin='user_explicit' AND EXISTS (
      SELECT 1 FROM tk_evidence e JOIN tk_sources s ON s.id=e.source_id
      WHERE e.memory_id=m.id AND e.revision=m.revision
        AND s.capture_method='profile_correction' AND s.origin='user_explicit'
    );
  UPDATE tk_revisions r SET origin='user_confirmed'
    WHERE r.origin='user_explicit' AND EXISTS (
      SELECT 1 FROM tk_evidence e JOIN tk_sources s ON s.id=e.source_id
      WHERE e.memory_id=r.memory_id AND e.revision=r.revision
        AND s.capture_method='profile_correction' AND s.origin='user_explicit'
    );
  UPDATE tk_sources SET origin='user_confirmed'
    WHERE capture_method='profile_correction' AND origin='user_explicit';

  UPDATE tk_revisions r SET status='active' FROM tk_memories m
    WHERE r.memory_id=m.id AND r.revision=m.revision AND m.status='candidate';
  UPDATE tk_memories SET status='active' WHERE status='candidate';
  UPDATE tk_owners SET snapshot_version=snapshot_version+1 WHERE id=ANY(changed_owners);
END $$;
