export type MemoryKind = 'fact' | 'preference' | 'decision' | 'constraint' | 'project_state';
export type Memory = {
  id: string; statement: string; subject: string; project_id: string | null;
  kind: MemoryKind; origin: string; status: string; revision: number;
  effective_at: string | null; created_at: string; updated_at: string; authoritative?: boolean;
};
export type Source = {
  id: string; event_id: string; client_id: string | null; text: string;
  author_role: string; origin: string; occurred_at: string | null; recorded_at: string;
  project_id: string | null; subject: string; capture_method?: string;
};
export type Evidence = { source_id: string; quote: string; revision: number };
export type Revision = { revision: number; statement: string; kind: MemoryKind; origin: string; status: string; effective_at: string | null; created_at: string; editor_client_id: string | null; extractor?: string | null };
export type Detail = { memory: Memory; sources: Source[]; evidence?: Evidence[]; revisions: Revision[] };
export type Client = { id: string; name: string; permissions: string[]; projects: string[] | null; created_at?: string; last_used_at?: string | null; revoked_at?: string | null };
export type CaptureSettings = { paused: boolean; version: number };
export type MemoryPage = { memories: Memory[]; next_offset: number | null; total_count: number; snapshot_version: number; ranking_version: string };
export type ImportResult = { imported_sources: number; existing_sources: number; skipped_sources: number; imported_memories: number; existing_memories: number; skipped_memories: number; tombstone_excluded_sources: number; tombstone_excluded_memories: number; evidence_excluded_memories: number; imported_tombstones: number; existing_tombstones: number };
export type CaptureStatus = {
  capture_id: string; client_id: string; project_id: string | null; subject: string; created_at: string;
  status: 'saved' | 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';
  source_ids: string[]; memory_ids: string[];
  job: { id: string; status: string; attempts: number; started_at: string | null; completed_at: string | null; error_code: string | null; accepted: number | null; skipped: number | null } | null;
  can_retry: boolean; retry_unavailable_reason: string | null;
};
export type CaptureReceipt = { capture_id: string; status: string; received_at: string };
export type DeletionTarget = { kind: 'memory' | 'source'; id: string };
export type DeletionPreview = {
  target: DeletionTarget; expected_revision: number | null; snapshot_version: number;
  preview_hash: string; blast_radius: 'whole_connected_source_events';
  memories: Memory[]; sources: Source[]; revision_count: number; evidence_count: number;
  jobs: { id: string; status: string; source_ids: string[]; affected_source_ids: string[] }[];
};
export type Page = 'memories' | 'inquiry' | 'captures' | 'connections' | 'portability';
export type Notice = { text: string; type: 'success' | 'error' };


export type Overview = { subjects: { subject: string; total_count: number; active_count: number; candidate_count: number }[]; total_count: number; active_count: number; candidate_count: number; source_count: number; snapshot_version: number };
