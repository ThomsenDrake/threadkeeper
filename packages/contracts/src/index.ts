import { z } from 'zod';

export const OriginSchema = z.enum(['user_explicit', 'user_confirmed', 'assistant_proposed', 'agent_reported', 'inferred']);
export const AuthorRoleSchema = z.enum(['user', 'assistant', 'system', 'unknown']);
export const MemoryKindSchema = z.enum(['fact', 'preference', 'decision', 'constraint', 'project_state']);
export const MemoryStatusSchema = z.enum(['candidate', 'active', 'disputed', 'superseded', 'dismissed']);
export const CaptureMethodSchema = z.enum(['explicit_capture', 'client_summary', 'profile_entry', 'profile_correction', 'profile_confirmation', 'import']);
const Identifier = z.string().min(1).max(200);
const Timestamp = z.string().datetime({ offset: true });

export const SourceEventSchema = z.object({
  id: Identifier,
  text: z.string().min(1).max(24_000),
  author_role: AuthorRoleSchema,
  origin: OriginSchema,
  occurred_at: Timestamp.optional(),
  client_id: Identifier.optional(),
  capture_method: CaptureMethodSchema.optional(),
}).strict();
export const ExplicitMemorySchema = z.object({
  statement: z.string().min(1).max(4_000),
  kind: MemoryKindSchema,
  source_event_id: Identifier,
  quote: z.string().min(1).max(24_000),
  origin: OriginSchema,
  subject: Identifier.optional(),
  effective_at: Timestamp.optional(),
}).strict();
export const CaptureSchema = z.object({
  idempotency_key: Identifier,
  project_id: Identifier.nullable().default(null),
  subject: Identifier.default('self'),
  events: z.array(SourceEventSchema).min(1).max(32),
  explicit_memories: z.array(ExplicitMemorySchema).max(64).optional(),
}).strict().superRefine((capture, ctx) => {
  if (new Set(capture.events.map(event => event.id)).size !== capture.events.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'Event IDs must be unique within a capture.' });
  }
  if (capture.events.reduce((size, event) => size + event.text.length, 0) > 64_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'A capture may contain at most 64,000 characters.' });
  }
});
export const SearchSchema = z.object({
  query: z.string().max(4_000).default(''),
  project_id: Identifier.nullable().optional(),
  subject: Identifier.optional(),
  source: Identifier.optional(),
  status: MemoryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
// Owner browsing is separate from bounded client recall. Later pages require
// both guards so canonical writes and ranking changes cannot silently move rows.
export const MemoryListSchema = SearchSchema.extend({
  offset: z.coerce.number().int().min(0).max(100_000).default(0).describe('Both consistency guards are required when offset is greater than 0.'),
  snapshot_version: z.coerce.number().int().min(0).optional().describe('Required when offset is greater than 0; use the snapshot_version returned by the first page.'),
  ranking_version: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Required when offset is greater than 0; use the ranking_version returned by the first page.'),
}).superRefine((input, ctx) => {
  if (input.offset > 0) {
    for (const guard of ['snapshot_version', 'ranking_version'] as const) {
      if (input[guard] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [guard], message: 'Required for pages after offset 0.' });
    }
  }
});
export const CorrectSchema = z.object({
  statement: z.string().min(1).max(4_000),
  kind: MemoryKindSchema.optional(),
  expected_revision: z.number().int().positive(),
  effective_at: Timestamp.nullable().optional(),
}).strict();
const PreviewHash = z.string().regex(/^[a-f0-9]{64}$/);
export const SourceDeleteSchema = z.object({ preview_hash: PreviewHash }).strict();
export const DeleteSchema = SourceDeleteSchema.extend({ expected_revision: z.number().int().positive() }).strict();
export const ReviewSchema = z.object({
  action: z.enum(['confirm', 'dismiss']), expected_revision: z.number().int().positive(),
  kind: MemoryKindSchema.optional(),
  statement: z.string().min(1).max(4_000).optional(), effective_at: Timestamp.nullable().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.action === 'dismiss' && (input.statement !== undefined || input.effective_at !== undefined || input.kind !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dismissal retains the current statement, kind and effective date.' });
  }
});
export const CaptureSettingsSchema = z.object({
  paused: z.boolean(), version: z.number().int().min(0),
}).strict();
export const CaptureSettingsUpdateSchema = z.object({
  paused: z.boolean(), expected_version: z.number().int().min(0).optional(),
}).strict();
export const CaptureListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
export const CaptureRetrySchema = z.object({ expected_attempts: z.number().int().min(0) }).strict();
export const CaptureStatusSchema = z.object({
  capture_id: Identifier, client_id: Identifier, project_id: Identifier.nullable(), subject: Identifier,
  created_at: Timestamp,
  status: z.enum(['saved', 'pending', 'processing', 'complete', 'failed', 'cancelled']),
  source_ids: z.array(Identifier), memory_ids: z.array(Identifier),
  job: z.object({
    id: Identifier, status: z.enum(['pending', 'processing', 'complete', 'failed', 'cancelled']),
    attempts: z.number().int().min(0), started_at: Timestamp.nullable(), completed_at: Timestamp.nullable(),
    error_code: z.string().nullable(), accepted: z.number().int().min(0).nullable(), skipped: z.number().int().min(0).nullable(),
  }).nullable(),
  can_retry: z.boolean(), retry_unavailable_reason: z.string().nullable(),
});
export const CaptureListResultSchema = z.object({ captures: z.array(CaptureStatusSchema), next_offset: z.number().int().min(0).nullable() });
export const MemorySchema = z.object({
  id: Identifier, project_id: Identifier.nullable(), subject: Identifier,
  statement: z.string().min(1).max(4_000), kind: MemoryKindSchema, origin: OriginSchema,
  status: MemoryStatusSchema, revision: z.number().int().positive(), authoritative: z.boolean(),
  effective_at: Timestamp.nullable(), created_at: Timestamp, updated_at: Timestamp,
  extractor: z.string().max(500).nullable(),
});
export const MemoryListResultSchema = z.object({
  memories: z.array(MemorySchema.passthrough()),
  next_offset: z.number().int().min(0).nullable(),
  total_count: z.number().int().min(0),
  snapshot_version: z.number().int().min(0),
  ranking_version: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();
export const ProfileOverviewSchema = z.object({
  subjects: z.array(z.object({
    subject: Identifier,
    total_count: z.number().int().min(0),
    active_count: z.number().int().min(0),
    candidate_count: z.number().int().min(0),
  })),
  total_count: z.number().int().min(0),
  active_count: z.number().int().min(0),
  candidate_count: z.number().int().min(0),
  source_count: z.number().int().min(0),
  snapshot_version: z.number().int().min(0),
});
export const ImportResultSchema = z.object({
  imported_sources: z.number().int().min(0), existing_sources: z.number().int().min(0), skipped_sources: z.number().int().min(0),
  imported_memories: z.number().int().min(0), existing_memories: z.number().int().min(0), skipped_memories: z.number().int().min(0),
  tombstone_excluded_sources: z.number().int().min(0), tombstone_excluded_memories: z.number().int().min(0),
  evidence_excluded_memories: z.number().int().min(0), imported_tombstones: z.number().int().min(0), existing_tombstones: z.number().int().min(0),
  retained_memories: z.number().int().min(0), snapshot_version: z.number().int().min(0),
});
export const ExportSourceSchema = z.object({
  id: Identifier, event_id: Identifier, client_id: Identifier, project_id: Identifier.nullable(), subject: Identifier,
  text: z.string().min(1).max(24_000), author_role: AuthorRoleSchema, origin: OriginSchema,
  occurred_at: Timestamp.nullable(), recorded_at: Timestamp,
  checksum: z.string().regex(/^[a-f0-9]{64}$/), extraction_blocked: z.boolean(),
  capture_method: CaptureMethodSchema,
}).strict();
export const EvidenceSchema = z.object({ memory_id: Identifier, revision: z.number().int().positive(), source_id: Identifier, quote: z.string().min(1).max(24_000) }).strict();
export const DeletionPreviewSchema = z.object({
  target: z.object({ kind: z.enum(['memory', 'source']), id: Identifier }).strict(),
  expected_revision: z.number().int().positive().nullable(),
  snapshot_version: z.number().int().min(0), preview_hash: PreviewHash,
  blast_radius: z.literal('whole_connected_source_events'),
  memories: z.array(MemorySchema), sources: z.array(ExportSourceSchema),
  revision_count: z.number().int().min(0), evidence_count: z.number().int().min(0),
  jobs: z.array(z.object({
    id: Identifier, status: z.enum(['pending', 'processing', 'complete', 'failed', 'cancelled']),
    source_ids: z.array(Identifier), affected_source_ids: z.array(Identifier),
  }).strict()),
}).strict();
export const RevisionSchema = z.object({
  memory_id: Identifier, revision: z.number().int().positive(), statement: z.string().min(1).max(4_000),
  kind: MemoryKindSchema,
  origin: OriginSchema, status: MemoryStatusSchema, effective_at: Timestamp.nullable(), created_at: Timestamp,
  editor_client_id: Identifier,
  extractor: z.string().max(500).nullable().default(null),
}).strict();
export const ExportSchema = z.object({
  schema_version: z.literal('threadkeeper.export.v2'),
  exported_at: Timestamp,
  sources: z.array(ExportSourceSchema).max(10_000),
  memories: z.array(MemorySchema).max(10_000),
  evidence: z.array(EvidenceSchema).max(50_000),
  revisions: z.array(RevisionSchema).max(50_000),
  tombstones: z.array(z.object({ kind: z.enum(['source_identity', 'source_content', 'memory_content']), hash: z.string().regex(/^[a-f0-9]{64}$/), deleted_at: Timestamp }).strict()).max(100_000),
}).strict();

// Before kind corrections, kind was immutable and appeared only on the memory.
// Keep v1 strict and distinct so a new-format history cannot omit revision kinds.
export const LegacyExportSchema = ExportSchema.extend({
  schema_version: z.literal('threadkeeper.export.v1'),
  revisions: z.array(RevisionSchema.omit({ kind: true })).max(50_000),
});
export const ImportSchema = z.discriminatedUnion('schema_version', [LegacyExportSchema, ExportSchema]);

export const DeletionLedgerSchema = z.object({
  schema_version: z.literal('threadkeeper.deletion-ledger.v1'),
  owner_id: Identifier,
  exported_at: Timestamp,
  snapshot_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tombstones: ExportSchema.shape.tombstones,
}).strict();

export type SourceEvent = z.infer<typeof SourceEventSchema>;
export type ExplicitMemory = z.infer<typeof ExplicitMemorySchema>;
export type CaptureInput = z.infer<typeof CaptureSchema>;
export type SearchInput = z.infer<typeof SearchSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type ExportBundle = z.infer<typeof ExportSchema>;
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export type DeletionPreview = z.infer<typeof DeletionPreviewSchema>;
export type DeletionLedger = z.infer<typeof DeletionLedgerSchema>;
