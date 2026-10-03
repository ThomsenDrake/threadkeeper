-- Keep the capture's authorization scope after jobs or sources are forgotten.
-- The receipt remains an immutable idempotency response, never a status cache.
ALTER TABLE tk_captures ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE tk_captures ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE tk_captures ADD COLUMN IF NOT EXISTS scope_known boolean NOT NULL DEFAULT false;
ALTER TABLE tk_captures ADD COLUMN IF NOT EXISTS source_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE tk_captures ADD COLUMN IF NOT EXISTS job_id text;

UPDATE tk_captures SET source_ids=ARRAY(SELECT jsonb_array_elements_text(result->'source_ids'))
WHERE cardinality(source_ids)=0 AND jsonb_typeof(result->'source_ids')='array';
UPDATE tk_captures SET job_id=result->>'job_id'
WHERE job_id IS NULL AND result->>'job_id' IS NOT NULL;

-- A canonical job supplies the original scope even after its evidence changed.
UPDATE tk_captures c SET project_id=j.project_id,subject=j.subject,scope_known=true
FROM tk_jobs j WHERE NOT c.scope_known AND c.job_id=j.id
  AND c.owner_id=j.owner_id AND c.client_id=j.client_id;

-- Without a job, infer scope only from the complete, consistent original source
-- set. Partial/deleted legacy captures remain visible to the owner alone.
UPDATE tk_captures c SET
  project_id=(SELECT s.project_id FROM tk_sources s WHERE s.id=ANY(c.source_ids) AND s.owner_id=c.owner_id AND s.client_id=c.client_id ORDER BY s.id LIMIT 1),
  subject=(SELECT s.subject FROM tk_sources s WHERE s.id=ANY(c.source_ids) AND s.owner_id=c.owner_id AND s.client_id=c.client_id ORDER BY s.id LIMIT 1),
  scope_known=true
WHERE NOT c.scope_known AND cardinality(c.source_ids)>0
  AND cardinality(c.source_ids)=(SELECT count(*) FROM tk_sources s WHERE s.id=ANY(c.source_ids) AND s.owner_id=c.owner_id AND s.client_id=c.client_id)
  AND NOT EXISTS (
    SELECT 1 FROM tk_sources a JOIN tk_sources b ON b.id=ANY(c.source_ids)
    WHERE a.id=ANY(c.source_ids) AND (a.project_id IS DISTINCT FROM b.project_id OR a.subject<>b.subject)
  );
CREATE INDEX IF NOT EXISTS tk_captures_recent ON tk_captures(owner_id,created_at DESC,id DESC);
