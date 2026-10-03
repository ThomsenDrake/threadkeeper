-- Owner-wide capture admission is independent of credentials and read access.
-- Existing authorized jobs retain their source/attempt fences while paused.
ALTER TABLE tk_owners ADD COLUMN IF NOT EXISTS capture_paused boolean NOT NULL DEFAULT false;
ALTER TABLE tk_owners ADD COLUMN IF NOT EXISTS capture_settings_version bigint NOT NULL DEFAULT 0;
-- This reports credential authentication, never transcript access or capture success.
ALTER TABLE tk_clients ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
