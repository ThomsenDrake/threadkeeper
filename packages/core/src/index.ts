import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createEmbeddingIndex, type EmbeddingProvider } from './embeddings.ts';
export type { EmbeddingProvider } from './embeddings.ts';
import {
  CaptureSchema, CaptureListSchema, CaptureRetrySchema, CaptureStatusSchema, CorrectSchema, DeleteSchema, ExportSchema, ExplicitMemorySchema, SearchSchema,
  type CaptureInput, type ExplicitMemory, type ExportBundle, type SourceEvent,
} from '@threadkeeper/contracts';

export type Database = {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
};
export type Auth = { ownerId: string; clientId: string; permissions: string[]; projects: string[] | null };
export type MemoryProvider = {
  extract(input: { events: SourceEvent[]; project_id: string | null; subject: string }): Promise<{
    memories: ExplicitMemory[]; model?: string; usage?: Record<string, number | undefined>;
  }>;
};
export class DomainError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); this.name = 'DomainError'; }
}

const uuid = () => randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => value === null || typeof value !== 'object'
  ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const sourceIdentity = (clientId: string, eventId: string) => hash(canonical([clientId, eventId]));
const sourceContent = (text: string) => hash(normalize(text));
const memoryContent = (statement: string, project: string | null, subject: string) => hash(canonical([normalize(statement), project, subject]));
const date = (value: any) => value == null ? null : new Date(value).toISOString();
const memoryRow = (row: any) => ({
  id: row.id, project_id: row.project_id, subject: row.subject, statement: row.statement,
  kind: row.kind, origin: row.origin, status: row.status, revision: Number(row.revision),
  authoritative: row.authoritative, effective_at: date(row.effective_at), created_at: date(row.created_at),
  updated_at: date(row.updated_at), extractor: row.extractor,
});
const sourceRow = (row: any) => ({
  id: row.id, event_id: row.event_id, client_id: row.client_id, project_id: row.project_id, subject: row.subject,
  text: row.text, author_role: row.author_role, origin: row.origin, occurred_at: date(row.occurred_at),
  recorded_at: date(row.recorded_at), checksum: row.checksum, extraction_blocked: row.extraction_blocked,
  capture_method: row.capture_method,
});
const revisionRow = (row: any) => ({
  memory_id: row.memory_id, revision: Number(row.revision), statement: row.statement, origin: row.origin,
  status: row.status, effective_at: date(row.effective_at), created_at: date(row.created_at), editor_client_id: row.editor_client_id,
});
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError(400, 'invalid_input', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return result.data;
}
function permission(auth: Auth, operation: string) {
  if (!auth.ownerId || !auth.clientId || (!auth.permissions.includes(operation) && !auth.permissions.includes('*'))) throw new DomainError(403, 'permission_denied');
}
function projectAllowed(auth: Auth, project: string | null) {
  if (project !== null && auth.projects !== null && !auth.projects.includes(project)) throw new DomainError(403, 'scope_denied');
}
function scope(auth: Auth, params: any[], alias = 'm') {
  params.push(auth.ownerId);
  let sql = `${alias}.owner_id = $${params.length}`;
  if (auth.projects !== null) { params.push(auth.projects); sql += ` AND (${alias}.project_id IS NULL OR ${alias}.project_id = ANY($${params.length}::text[]))`; }
  return sql;
}
async function lockOwner(tx: Database, ownerId: string) {
  await tx.query('INSERT INTO tk_owners(id) VALUES ($1) ON CONFLICT DO NOTHING', [ownerId]);
  await tx.query('SELECT id FROM tk_owners WHERE id=$1 FOR UPDATE', [ownerId]);
}
async function bump(tx: Database, ownerId: string) {
  const result = await tx.query('UPDATE tk_owners SET snapshot_version=snapshot_version+1 WHERE id=$1 RETURNING snapshot_version', [ownerId]);
  return Number(result.rows[0].snapshot_version);
}
async function snapshot(tx: Database, ownerId: string) {
  const result = await tx.query('SELECT snapshot_version FROM tk_owners WHERE id=$1', [ownerId]);
  return Number(result.rows[0]?.snapshot_version ?? 0);
}
async function tombstoned(tx: Database, ownerId: string, kind: string, digest: string) {
  return (await tx.query('SELECT 1 FROM tk_tombstones WHERE owner_id=$1 AND kind=$2 AND hash=$3', [ownerId, kind, digest])).rows.length > 0;
}
async function findMemory(tx: Database, auth: Auth, id: string, lock = false) {
  const params: any[] = [id];
  const result = await tx.query(`SELECT m.* FROM tk_memories m WHERE m.id=$1 AND ${scope(auth, params)}${lock ? ' FOR UPDATE' : ''}`, params);
  if (!result.rows[0]) throw new DomainError(404, 'memory_not_found');
  return result.rows[0];
}
function validateAttribution(memory: ExplicitMemory, source: any) {
  if (!source || !source.text.includes(memory.quote)) throw new DomainError(400, 'evidence_mismatch', 'Every quote must exactly match its referenced source event.');
  if (['user_explicit', 'user_confirmed'].includes(memory.origin)
    && (source.author_role !== 'user' || !['user_explicit', 'user_confirmed'].includes(source.origin))) {
    throw new DomainError(400, 'author_misattribution', 'A user statement requires original user-authored evidence. Agent reports and assistant text cannot be relabeled as user statements.');
  }
  if (memory.origin === 'user_confirmed' && source.origin !== 'user_confirmed') throw new DomainError(400, 'unconfirmed_origin');
  if (source.origin === 'agent_reported' && !['agent_reported', 'inferred', 'assistant_proposed'].includes(memory.origin)) throw new DomainError(400, 'report_misattribution');
  if (source.origin === 'assistant_proposed' && !['assistant_proposed', 'inferred'].includes(memory.origin)) throw new DomainError(400, 'proposal_misattribution', 'An unaccepted assistant proposal must remain a proposal or an inference.');
}
function validateSource(event: SourceEvent) {
  if (['user_explicit', 'user_confirmed'].includes(event.origin) && event.author_role !== 'user') throw new DomainError(400, 'author_misattribution');
  if (event.origin === 'assistant_proposed' && event.author_role !== 'assistant') throw new DomainError(400, 'author_misattribution');
}
async function insertMemory(tx: Database, auth: Auth, candidate: ExplicitMemory, source: any, extractor: string | null) {
  validateAttribution(candidate, source);
  const subject = candidate.subject ?? source.subject;
  if (subject !== source.subject) throw new DomainError(400, 'evidence_scope_mismatch', 'A memory and its evidence must have the same subject.');
  if (source.extraction_blocked) return { id: null, skipped: 'source_corrected' };
  if (await tombstoned(tx, auth.ownerId, 'memory_content', memoryContent(candidate.statement, source.project_id, subject))) return { id: null, skipped: 'deleted_content' };
  const obsolete = await tx.query(`SELECT r.statement FROM tk_revisions r JOIN tk_memories m ON m.id=r.memory_id
    WHERE m.owner_id=$1 AND m.project_id IS NOT DISTINCT FROM $2 AND m.subject=$3
      AND m.authoritative=true AND r.revision<m.revision`, [auth.ownerId, source.project_id, subject]);
  if (obsolete.rows.some(row => normalize(row.statement) === normalize(candidate.statement))) return { id: null, skipped: 'superseded_statement' };
  const contentKey = hash(canonical([source.id, normalize(candidate.statement), candidate.kind, candidate.origin, subject]));
  const existing = await tx.query('SELECT id FROM tk_memories WHERE owner_id=$1 AND content_key=$2', [auth.ownerId, contentKey]);
  if (existing.rows[0]) return { id: existing.rows[0].id, skipped: 'duplicate' };
  const id = uuid();
  const status = ['inferred', 'assistant_proposed'].includes(candidate.origin) ? 'candidate' : 'active';
  await tx.query(`INSERT INTO tk_memories(id,owner_id,project_id,subject,statement,kind,origin,status,effective_at,extractor,content_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, auth.ownerId, source.project_id, subject, candidate.statement, candidate.kind, candidate.origin, status, candidate.effective_at ?? null, extractor, contentKey]);
  await tx.query(`INSERT INTO tk_revisions(memory_id,revision,statement,origin,status,effective_at,editor_client_id)
    VALUES ($1,1,$2,$3,$4,$5,$6)`, [id, candidate.statement, candidate.origin, status, candidate.effective_at ?? null, auth.clientId]);
  await tx.query('INSERT INTO tk_evidence(memory_id,revision,source_id,quote) VALUES ($1,1,$2,$3)', [id, source.id, candidate.quote]);
  return { id, skipped: null };
}

export function createStore(db: Database, options: { embeddings?: EmbeddingProvider } = {}) {
  const embeddingIndex = createEmbeddingIndex(db, options.embeddings);
  async function capture(auth: Auth, raw: unknown) {
    permission(auth, 'capture');
    const input = parsed(CaptureSchema, raw) as CaptureInput;
    projectAllowed(auth, input.project_id);
    input.events.forEach(validateSource);
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const payloadHash = hash(canonical(input));
      const prior = await tx.query('SELECT payload_hash,result FROM tk_captures WHERE owner_id=$1 AND client_id=$2 AND idempotency_key=$3', [auth.ownerId, auth.clientId, input.idempotency_key]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== payloadHash) throw new DomainError(409, 'idempotency_conflict');
        return { ...prior.rows[0].result, replayed: true };
      }
      const sources = new Map<string, any>();
      for (const event of input.events) {
        if (event.capture_method === 'profile_correction' || (event.capture_method === 'profile_entry' && auth.clientId !== 'profile')) throw new DomainError(400, 'invalid_capture_method');
        const captureMethod = auth.clientId === 'profile' ? 'profile_entry' : event.origin === 'agent_reported' ? 'client_summary' : event.capture_method ?? 'explicit_capture';
        if (await tombstoned(tx, auth.ownerId, 'source_identity', sourceIdentity(auth.clientId, event.id))
          || await tombstoned(tx, auth.ownerId, 'source_content', sourceContent(event.text))) throw new DomainError(410, 'deleted_source', 'This source was deleted and cannot be replayed.');
        const checksum = hash(event.text);
        const old = await tx.query('SELECT * FROM tk_sources WHERE owner_id=$1 AND client_id=$2 AND event_id=$3', [auth.ownerId, auth.clientId, event.id]);
        if (old.rows[0]) {
          const row = old.rows[0];
          if (row.checksum !== checksum || row.author_role !== event.author_role || row.origin !== event.origin || row.capture_method !== captureMethod || row.project_id !== input.project_id || row.subject !== input.subject || date(row.occurred_at) !== date(event.occurred_at)) throw new DomainError(409, 'event_conflict', 'A stable event ID cannot be reused with changed content or scope.');
          sources.set(event.id, row);
          continue;
        }
        const source = (await tx.query(`INSERT INTO tk_sources(id,owner_id,client_id,event_id,project_id,subject,text,author_role,origin,occurred_at,checksum,capture_method)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [uuid(), auth.ownerId, auth.clientId, event.id, input.project_id, input.subject, event.text, event.author_role, event.origin, event.occurred_at ?? null, checksum, captureMethod])).rows[0];
        sources.set(event.id, source);
      }
      const memoryIds: string[] = [];
      for (const candidate of input.explicit_memories ?? []) {
        const result = await insertMemory(tx, auth, candidate, sources.get(candidate.source_event_id), null);
        if (result.id) memoryIds.push(result.id);
      }
      const captureId = uuid();
      const sourceIds = [...sources.values()].map(source => source.id);
      let jobId: string | undefined;
      if (input.explicit_memories === undefined && [...sources.values()].some(source => !source.extraction_blocked)) {
        jobId = uuid();
        await tx.query(`INSERT INTO tk_jobs(id,owner_id,client_id,project_id,subject,source_ids) VALUES ($1,$2,$3,$4,$5,$6)`, [jobId, auth.ownerId, auth.clientId, input.project_id, input.subject, sourceIds]);
      }
      const result = { capture_id: captureId, source_ids: sourceIds, memory_ids: [...new Set(memoryIds)], status: jobId ? 'pending' : 'complete', ...(jobId ? { job_id: jobId } : {}), snapshot_version: await bump(tx, auth.ownerId) };
      await tx.query(`INSERT INTO tk_captures(id,owner_id,client_id,idempotency_key,payload_hash,result,project_id,subject,scope_known,source_ids,job_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true,$9,$10)`, [captureId, auth.ownerId, auth.clientId, input.idempotency_key, payloadHash, JSON.stringify(result), input.project_id, input.subject, sourceIds, jobId ?? null]);
      return result;
    });
  }

  function captureScope(auth: Auth, params: any[]) {
    // Capture-only credentials can inspect their own submissions without gaining
    // recall access to another client's sources or extraction results.
    if (!auth.permissions.includes('read') && !auth.permissions.includes('*')) permission(auth, 'capture');
    else permission(auth, 'read');
    let where = scope(auth, params, 'c');
    if (!(auth.projects === null && (auth.permissions.includes('*') || auth.permissions.includes('admin')))) where += ' AND c.scope_known=true';
    if (!auth.permissions.includes('read') && !auth.permissions.includes('*')) {
      params.push(auth.clientId);
      where += ` AND c.client_id=$${params.length}`;
    }
    return where;
  }
  async function findCapture(tx: Database, auth: Auth, id: string) {
    const params: any[] = [id];
    const row = (await tx.query(`SELECT c.* FROM tk_captures c WHERE c.id=$1 AND ${captureScope(auth, params)}`, params)).rows[0];
    if (!row) throw new DomainError(404, 'capture_not_found');
    return row;
  }
  async function currentCapture(tx: Database, auth: Auth, capture: any) {
    const sources = (await tx.query('SELECT id,extraction_blocked FROM tk_sources WHERE owner_id=$1 AND id=ANY($2::text[]) ORDER BY id', [auth.ownerId, capture.source_ids])).rows;
    const job = capture.job_id ? (await tx.query('SELECT * FROM tk_jobs WHERE id=$1 AND owner_id=$2 AND client_id=$3', [capture.job_id, auth.ownerId, capture.client_id])).rows[0] : null;
    const memories = (await tx.query(`SELECT DISTINCT m.id FROM tk_memories m
      JOIN tk_evidence e ON e.memory_id=m.id JOIN tk_sources s ON s.id=e.source_id
      WHERE m.owner_id=$1 AND s.owner_id=$1 AND s.id=ANY($2::text[]) ORDER BY m.id`, [auth.ownerId, sources.map(source => source.id)])).rows;
    const eligible = sources.some(source => !source.extraction_blocked);
    const status = capture.job_id ? (job?.status ?? 'cancelled') : sources.length ? 'saved' : 'cancelled';
    const retryReason = !auth.permissions.includes('retry') && !auth.permissions.includes('*') ? 'owner_retry_required'
      : !capture.job_id ? 'extraction_not_requested' : !job ? 'job_unavailable'
        : !eligible ? 'sources_unavailable' : job.status !== 'failed' ? 'job_not_failed' : null;
    return parsed(CaptureStatusSchema, {
      capture_id: capture.id, client_id: capture.client_id, project_id: capture.project_id,
      subject: capture.subject ?? 'unknown', created_at: date(capture.created_at), status,
      source_ids: sources.map(source => source.id), memory_ids: memories.map(memory => memory.id),
      job: job ? {
        id: job.id, status: job.status, attempts: Number(job.attempts), started_at: date(job.started_at),
        completed_at: date(job.completed_at), error_code: job.error_code,
        accepted: Number.isInteger(job.result?.accepted) ? job.result.accepted : null,
        skipped: Number.isInteger(job.result?.skipped) ? job.result.skipped : null,
      } : null,
      can_retry: retryReason === null, retry_unavailable_reason: retryReason,
    });
  }
  async function captureStatus(auth: Auth, id: string) {
    captureScope(auth, []);
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      return currentCapture(tx, auth, await findCapture(tx, auth, id));
    });
  }
  async function listCaptures(auth: Auth, raw: unknown = {}) {
    const filters = parsed(CaptureListSchema, raw);
    const params: any[] = [];
    const where = captureScope(auth, params);
    params.push(filters.limit + 1, filters.offset);
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const rows = (await tx.query(`SELECT c.* FROM tk_captures c WHERE ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
      const captures = [];
      for (const row of rows.slice(0, filters.limit)) captures.push(await currentCapture(tx, auth, row));
      return { captures, next_offset: rows.length > filters.limit ? filters.offset + filters.limit : null };
    });
  }
  async function retryCapture(auth: Auth, id: string, raw: unknown) {
    permission(auth, 'retry');
    const input = parsed(CaptureRetrySchema, raw);
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const capture = await findCapture(tx, auth, id);
      const job = capture.job_id ? (await tx.query('SELECT * FROM tk_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [capture.job_id, auth.ownerId])).rows[0] : null;
      if (job && Number(job.attempts) !== input.expected_attempts) throw new DomainError(409, 'attempt_conflict');
      const current = await currentCapture(tx, auth, capture);
      if (!current.can_retry) throw new DomainError(409, 'retry_unavailable', current.retry_unavailable_reason!);
      // Preserve the source/job identity and attempt fence. Only claiming a job
      // increments attempts, so double retry and stale workers cannot admit twice.
      await tx.query("UPDATE tk_jobs SET status='pending',started_at=NULL,completed_at=NULL,error_code=NULL,result=NULL WHERE id=$1", [job.id]);
      return currentCapture(tx, auth, capture);
    });
  }

  async function select(auth: Auth, raw: unknown, defaultsActive: boolean) {
    permission(auth, 'read');
    const filters = parsed(SearchSchema, raw);
    if (filters.project_id !== undefined) projectAllowed(auth, filters.project_id);
    const params: any[] = [];
    const where = [scope(auth, params)];
    if (filters.project_id !== undefined) { params.push(filters.project_id); where.push(`m.project_id IS NOT DISTINCT FROM $${params.length}`); }
    if (filters.subject !== undefined) { params.push(filters.subject); where.push(`m.subject=$${params.length}`); }
    if (filters.status !== undefined || defaultsActive) { params.push(filters.status ?? 'active'); where.push(`m.status=$${params.length}`); }
    if (filters.source !== undefined) {
      params.push(filters.source);
      where.push(`EXISTS (SELECT 1 FROM tk_evidence e JOIN tk_sources s ON s.id=e.source_id WHERE e.memory_id=m.id AND e.revision=m.revision AND (s.id=$${params.length} OR s.client_id=$${params.length}))`);
    }
    const query = filters.query.trim();
    // Authorization and filter validation precede any provider call. Only the
    // query leaves this path; memory indexing is a separate trusted worker task.
    // No database lock is held across a remote request. The final read takes the
    // owner lock and joins current revisions after the request has completed.
    const semantic = query ? await embeddingIndex.query(query) : { vector: null, reason: 'not_requested' };
    const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const evidence = `(SELECT jsonb_agg(jsonb_build_object('source_id',e.source_id,'quote',e.quote,'client_id',s.client_id,'author_role',s.author_role,'origin',s.origin,'capture_method',s.capture_method,'occurred_at',s.occurred_at,'recorded_at',s.recorded_at)) FROM tk_evidence e JOIN tk_sources s ON s.id=e.source_id WHERE e.memory_id=m.id AND e.revision=m.revision) AS evidence`;
    let sql: string;
    if (semantic.vector) {
      const q = bind(query);
      const space = bind(embeddingIndex.spaceId);
      const dimensions = bind(embeddingIndex.dimensions);
      const vector = bind(JSON.stringify(semantic.vector));
      const candidateLimit = bind(filters.limit * 4);
      const limit = bind(filters.limit);
      // One materialized, authorized relation feeds BOTH rankers, including all
      // subject/source/status filters. Exact cosine supports large vectors and
      // avoids ANN post-filter underfilling of project-scoped personal context.
      // Materializing compatible vectors also prevents distance evaluation on
      // vectors from a different model/dimension if the planner reorders joins.
      sql = `WITH eligible AS MATERIALIZED (
          SELECT m.* FROM tk_memories m WHERE ${where.join(' AND ')}
        ), lexical AS (
          SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector,websearch_to_tsquery('english',${q})) DESC,updated_at DESC,id) AS rank
          FROM eligible WHERE search_vector @@ websearch_to_tsquery('english',${q}) OR position(lower(${q}) in lower(statement)) > 0
          ORDER BY rank LIMIT ${candidateLimit}
        ), compatible_vectors AS MATERIALIZED (
          SELECT m.id,m.updated_at,e.embedding FROM eligible m JOIN tk_embeddings e ON e.memory_id=m.id AND e.revision=m.revision
          WHERE e.space_id=${space} AND e.dimensions=${dimensions} AND vector_dims(e.embedding)=${dimensions}
        ), distances AS MATERIALIZED (
          SELECT id,updated_at,1-(embedding <=> ${vector}::vector) AS similarity FROM compatible_vectors
        ), semantic AS (
          SELECT id,row_number() OVER (ORDER BY similarity DESC,updated_at DESC,id) AS rank
          FROM distances WHERE similarity >= 0.3 AND similarity <= 1.000001 ORDER BY rank LIMIT ${candidateLimit}
        ), fused AS (
          SELECT id,sum(score) AS score FROM (
            SELECT id,1.0/(60+rank) AS score FROM lexical
            UNION ALL SELECT id,1.0/(60+rank) AS score FROM semantic
          ) ranks GROUP BY id
        )
        SELECT m.*,${evidence} FROM eligible m JOIN fused ON fused.id=m.id
        ORDER BY fused.score DESC,m.updated_at DESC,m.id LIMIT ${limit}`;
    } else {
      let rank = 'm.updated_at DESC,m.id';
      if (query) {
        const q = bind(query);
        // Preserve credential-free word-form matching and exact date/ID fragments.
        where.push(`(m.search_vector @@ websearch_to_tsquery('english',${q}) OR position(lower(${q}) in lower(m.statement)) > 0)`);
        rank = `ts_rank_cd(m.search_vector,websearch_to_tsquery('english',${q})) DESC,m.updated_at DESC,m.id`;
      }
      sql = `SELECT m.*,${evidence} FROM tk_memories m WHERE ${where.join(' AND ')} ORDER BY ${rank} LIMIT ${bind(filters.limit)}`;
    }
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const result = await tx.query(sql, params);
      return { memories: result.rows.map(row => ({ ...memoryRow(row), evidence: row.evidence ?? [] })), snapshot_version: await snapshot(tx, auth.ownerId), coverage: { retrieval: semantic.vector ? 'postgresql_hybrid' : 'postgresql_full_text', semantic_search: semantic.reason, result_limit: filters.limit, insufficient_context: result.rows.length === 0 } };
    });
  }
  async function detail(auth: Auth, id: string) {
    permission(auth, 'read');
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const row = await findMemory(tx, auth, id);
      const sources = await tx.query('SELECT DISTINCT s.* FROM tk_sources s JOIN tk_evidence e ON s.id=e.source_id WHERE e.memory_id=$1 ORDER BY s.recorded_at', [id]);
      const evidence = await tx.query('SELECT memory_id,revision,source_id,quote FROM tk_evidence WHERE memory_id=$1 ORDER BY revision', [id]);
      const revisions = await tx.query('SELECT * FROM tk_revisions WHERE memory_id=$1 ORDER BY revision', [id]);
      return { memory: memoryRow(row), sources: sources.rows.map(sourceRow), evidence: evidence.rows, revisions: revisions.rows.map(revisionRow) };
    });
  }
  async function getSource(auth: Auth, id: string) {
    permission(auth, 'read');
    const params: any[] = [id];
    const result = await db.query(`SELECT s.* FROM tk_sources s WHERE s.id=$1 AND ${scope(auth, params, 's')}`, params);
    if (!result.rows[0]) throw new DomainError(404, 'source_not_found');
    return sourceRow(result.rows[0]);
  }
  async function correct(auth: Auth, id: string, raw: unknown) {
    permission(auth, 'correct');
    const input = parsed(CorrectSchema, raw);
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const memory = await findMemory(tx, auth, id, true);
      if (Number(memory.revision) !== input.expected_revision) throw new DomainError(409, 'revision_conflict');
      if (await tombstoned(tx, auth.ownerId, 'memory_content', memoryContent(input.statement, memory.project_id, memory.subject))) throw new DomainError(410, 'deleted_content');
      const siblings = (await tx.query('SELECT id,statement,revision FROM tk_memories WHERE owner_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND subject=$3 AND id<>$4', [auth.ownerId, memory.project_id, memory.subject, id])).rows
        .filter(row => normalize(row.statement) === normalize(memory.statement));
      for (const sibling of siblings) {
        await tx.query("UPDATE tk_memories SET status='superseded',updated_at=now() WHERE id=$1", [sibling.id]);
        await tx.query("UPDATE tk_revisions SET status='superseded' WHERE memory_id=$1 AND revision=$2", [sibling.id, sibling.revision]);
        await tx.query('UPDATE tk_sources SET extraction_blocked=true WHERE id IN (SELECT source_id FROM tk_evidence WHERE memory_id=$1)', [sibling.id]);
      }
      // Old source events remain available as history, but no pending extractor can admit them again.
      await tx.query('UPDATE tk_sources SET extraction_blocked=true WHERE id IN (SELECT source_id FROM tk_evidence WHERE memory_id=$1)', [id]);
      await tx.query(`UPDATE tk_jobs j SET status='cancelled',completed_at=now(),error_code=NULL,result=NULL
        WHERE j.owner_id=$1 AND j.status IN ('pending','processing','failed') AND NOT EXISTS (
          SELECT 1 FROM tk_sources s WHERE s.owner_id=j.owner_id AND s.id=ANY(j.source_ids) AND s.extraction_blocked=false
        )`, [auth.ownerId]);
      const sourceId = uuid();
      await tx.query(`INSERT INTO tk_sources(id,owner_id,client_id,event_id,project_id,subject,text,author_role,origin,occurred_at,checksum,extraction_blocked,capture_method)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'user','user_explicit',now(),$8,true,'profile_correction')`, [sourceId, auth.ownerId, auth.clientId, `correction:${id}:${input.expected_revision + 1}`, memory.project_id, memory.subject, input.statement, hash(input.statement)]);
      const effectiveAt = input.effective_at === undefined ? memory.effective_at : input.effective_at;
      const updated = (await tx.query(`UPDATE tk_memories SET statement=$2,origin='user_explicit',status='active',authoritative=true,revision=revision+1,effective_at=$3,updated_at=now(),extractor=NULL
        WHERE id=$1 RETURNING *`, [id, input.statement, effectiveAt])).rows[0];
      await tx.query(`INSERT INTO tk_revisions(memory_id,revision,statement,origin,status,effective_at,editor_client_id) VALUES ($1,$2,$3,'user_explicit','active',$4,$5)`, [id, updated.revision, input.statement, effectiveAt, auth.clientId]);
      await tx.query('INSERT INTO tk_evidence(memory_id,revision,source_id,quote) VALUES ($1,$2,$3,$4)', [id, updated.revision, sourceId, input.statement]);
      await tx.query("UPDATE tk_revisions SET status='superseded' WHERE memory_id=$1 AND revision<$2", [id, updated.revision]);
      return { memory: memoryRow(updated), superseded_memory_ids: siblings.map(row => row.id), snapshot_version: await bump(tx, auth.ownerId) };
    });
  }

  async function remove(auth: Auth, id: string, raw: unknown) {
    permission(auth, 'delete');
    const input = parsed(DeleteSchema, raw);
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const target = await findMemory(tx, auth, id, true);
      if (Number(target.revision) !== input.expected_revision) throw new DomainError(409, 'revision_conflict');
      // Conservative graph closure: forgetting one assertion scrubs whole connected source events.
      // This removes sibling assertions from the same event so retained evidence cannot recreate it.
      const memoryIds = new Set<string>([id]);
      const targetHistory = (await tx.query('SELECT statement FROM tk_revisions WHERE memory_id=$1', [id])).rows.map(row => normalize(row.statement));
      const sameAssertions = await tx.query('SELECT DISTINCT m.id,r.statement FROM tk_memories m JOIN tk_revisions r ON r.memory_id=m.id WHERE m.owner_id=$1 AND m.project_id IS NOT DISTINCT FROM $2 AND m.subject=$3', [auth.ownerId, target.project_id, target.subject]);
      sameAssertions.rows.filter(row => targetHistory.includes(normalize(row.statement))).forEach(row => memoryIds.add(row.id));
      const sourceIds = new Set<string>();
      let changed = true;
      while (changed) {
        const before = memoryIds.size + sourceIds.size;
        const sources = await tx.query('SELECT DISTINCT source_id FROM tk_evidence WHERE memory_id=ANY($1::text[])', [[...memoryIds]]);
        sources.rows.forEach(row => sourceIds.add(row.source_id));
        const memories = await tx.query('SELECT DISTINCT e.memory_id FROM tk_evidence e JOIN tk_memories m ON m.id=e.memory_id WHERE e.source_id=ANY($1::text[]) AND m.owner_id=$2', [[...sourceIds], auth.ownerId]);
        memories.rows.forEach(row => memoryIds.add(row.memory_id));
        changed = before !== memoryIds.size + sourceIds.size;
      }
      const sources = await tx.query('SELECT * FROM tk_sources WHERE id=ANY($1::text[]) AND owner_id=$2', [[...sourceIds], auth.ownerId]);
      const revisions = await tx.query('SELECT r.statement,m.project_id,m.subject FROM tk_revisions r JOIN tk_memories m ON m.id=r.memory_id WHERE m.id=ANY($1::text[])', [[...memoryIds]]);
      const tombstones: Array<[string, string]> = sources.rows.flatMap(source => [['source_identity', sourceIdentity(source.client_id, source.event_id)], ['source_content', sourceContent(source.text)]] as Array<[string, string]>);
      revisions.rows.forEach(row => tombstones.push(['memory_content', memoryContent(row.statement, row.project_id, row.subject)]));
      for (const [kind, digest] of tombstones) await tx.query('INSERT INTO tk_tombstones(owner_id,kind,hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [auth.ownerId, kind, digest]);
      await tx.query('DELETE FROM tk_jobs WHERE owner_id=$1 AND source_ids && $2::text[]', [auth.ownerId, [...sourceIds]]);
      await tx.query('DELETE FROM tk_memories WHERE owner_id=$1 AND id=ANY($2::text[])', [auth.ownerId, [...memoryIds]]);
      await tx.query('DELETE FROM tk_sources WHERE owner_id=$1 AND id=ANY($2::text[])', [auth.ownerId, [...sourceIds]]);
      return { deleted_memory_ids: [...memoryIds], deleted_source_ids: [...sourceIds], deleted_count: memoryIds.size, blast_radius: 'whole_connected_source_events', snapshot_version: await bump(tx, auth.ownerId) };
    });
  }

  async function exportData(auth: Auth): Promise<ExportBundle> {
    permission(auth, 'export');
    if (auth.projects !== null) throw new DomainError(403, 'owner_export_required');
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      const sources = await tx.query('SELECT * FROM tk_sources WHERE owner_id=$1 ORDER BY recorded_at,id', [auth.ownerId]);
      const memories = await tx.query('SELECT * FROM tk_memories WHERE owner_id=$1 ORDER BY created_at,id', [auth.ownerId]);
      const evidence = await tx.query('SELECT e.* FROM tk_evidence e JOIN tk_memories m ON m.id=e.memory_id WHERE m.owner_id=$1 ORDER BY e.memory_id,e.revision', [auth.ownerId]);
      const revisions = await tx.query('SELECT r.* FROM tk_revisions r JOIN tk_memories m ON m.id=r.memory_id WHERE m.owner_id=$1 ORDER BY r.memory_id,r.revision', [auth.ownerId]);
      const tombstones = await tx.query('SELECT kind,hash,deleted_at FROM tk_tombstones WHERE owner_id=$1 ORDER BY kind,hash', [auth.ownerId]);
      return parsed(ExportSchema, { schema_version: 'threadkeeper.export.v1', exported_at: new Date().toISOString(), sources: sources.rows.map(sourceRow), memories: memories.rows.map(memoryRow), evidence: evidence.rows, revisions: revisions.rows.map(revisionRow), tombstones: tombstones.rows.map(row => ({ ...row, deleted_at: date(row.deleted_at) })) });
    });
  }
  async function importData(auth: Auth, raw: unknown) {
    permission(auth, 'import');
    if (auth.projects !== null) throw new DomainError(403, 'owner_import_required');
    const bundle = parsed(ExportSchema, raw);
    const sources = new Map(bundle.sources.map(source => [source.id, source]));
    const memories = new Map(bundle.memories.map(memory => [memory.id, memory]));
    const revisions = new Map(bundle.revisions.map(revision => [`${revision.memory_id}:${revision.revision}`, revision]));
    if (sources.size !== bundle.sources.length || memories.size !== bundle.memories.length || revisions.size !== bundle.revisions.length) throw new DomainError(400, 'duplicate_import_id');
    if (new Set(bundle.sources.map(source => canonical([source.client_id, source.event_id]))).size !== bundle.sources.length
      || new Set(bundle.evidence.map(evidence => canonical([evidence.memory_id, evidence.revision, evidence.source_id]))).size !== bundle.evidence.length) throw new DomainError(400, 'duplicate_import_id');
    for (const source of sources.values()) {
      if (hash(source.text) !== source.checksum) throw new DomainError(400, 'checksum_mismatch');
      validateSource({ id: source.event_id, text: source.text, author_role: source.author_role, origin: source.origin });
    }
    for (const revision of revisions.values()) {
      if (!memories.has(revision.memory_id)) throw new DomainError(400, 'orphan_revision');
      if (!bundle.evidence.some(evidence => evidence.memory_id === revision.memory_id && evidence.revision === revision.revision)) throw new DomainError(400, 'missing_evidence');
    }
    for (const memory of memories.values()) {
      const history = bundle.revisions.filter(revision => revision.memory_id === memory.id).sort((a, b) => a.revision - b.revision);
      if (history.length !== memory.revision || history.some((revision, index) => revision.revision !== index + 1
        || (revision.revision < memory.revision && revision.status !== 'superseded'))) throw new DomainError(400, 'invalid_revision_history');
      const current = revisions.get(`${memory.id}:${memory.revision}`);
      if (!current || current.statement !== memory.statement || current.origin !== memory.origin || current.status !== memory.status || current.effective_at !== memory.effective_at) throw new DomainError(400, 'revision_mismatch');
      if (memory.authoritative && (memory.origin !== 'user_explicit' || memory.revision < 2)) throw new DomainError(400, 'invalid_authority');
      if (memory.authoritative && !bundle.evidence.some(evidence => {
        if (evidence.memory_id !== memory.id || evidence.revision !== memory.revision) return false;
        const source = sources.get(evidence.source_id);
        return source?.author_role === 'user' && source.origin === 'user_explicit' && source.extraction_blocked && source.capture_method === 'profile_correction'
          && source.text === memory.statement && evidence.quote === memory.statement
          && source.event_id === `correction:${memory.id}:${memory.revision}` && source.client_id === current.editor_client_id;
      })) throw new DomainError(400, 'invalid_authority', 'Authoritative corrections must have a user-authored correction source matching the current revision.');
      if (memory.authoritative && bundle.evidence.some(evidence => evidence.memory_id === memory.id
        && evidence.revision < memory.revision && !sources.get(evidence.source_id)?.extraction_blocked)) throw new DomainError(400, 'invalid_correction_history', 'Superseded evidence cannot be eligible for extraction after a correction.');
    }
    for (const evidence of bundle.evidence) {
      const source = sources.get(evidence.source_id);
      const memory = memories.get(evidence.memory_id);
      const revision = revisions.get(`${evidence.memory_id}:${evidence.revision}`);
      if (!source || !memory || !revision) throw new DomainError(400, 'orphan_evidence');
      if (source.project_id !== memory.project_id || source.subject !== memory.subject) throw new DomainError(400, 'evidence_scope_mismatch');
      validateAttribution({ statement: revision.statement, kind: memory.kind, source_event_id: source.event_id, quote: evidence.quote, origin: revision.origin }, source);
    }
    return db.transaction(async tx => {
      await lockOwner(tx, auth.ownerId);
      // Importing tombstones into a nonempty instance could otherwise leave active deleted content.
      // Require a fresh destination for incoming deletion history, or an identical existing history.
      for (const tombstone of bundle.tombstones) {
        const already = await tombstoned(tx, auth.ownerId, tombstone.kind, tombstone.hash);
        if (!already && (await tx.query('SELECT 1 FROM tk_sources WHERE owner_id=$1 LIMIT 1', [auth.ownerId])).rows.length) throw new DomainError(409, 'fresh_import_required', 'Import deletion history into a fresh instance.');
        await tx.query('INSERT INTO tk_tombstones(owner_id,kind,hash,deleted_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [auth.ownerId, tombstone.kind, tombstone.hash, tombstone.deleted_at]);
      }
      const allowedSources = new Set<string>();
      for (const source of bundle.sources) {
        if (await tombstoned(tx, auth.ownerId, 'source_identity', sourceIdentity(source.client_id, source.event_id)) || await tombstoned(tx, auth.ownerId, 'source_content', sourceContent(source.text))) continue;
        const old = await tx.query('SELECT * FROM tk_sources WHERE id=$1 OR (owner_id=$2 AND client_id=$3 AND event_id=$4)', [source.id, auth.ownerId, source.client_id, source.event_id]);
        if (old.rows.length) {
          const row = old.rows[0];
          if (row.id !== source.id || row.owner_id !== auth.ownerId || canonical(sourceRow(row)) !== canonical(source)) throw new DomainError(409, 'import_source_conflict');
        } else {
          await tx.query(`INSERT INTO tk_sources(id,owner_id,client_id,event_id,project_id,subject,text,author_role,origin,occurred_at,recorded_at,checksum,extraction_blocked,capture_method)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [source.id, auth.ownerId, source.client_id, source.event_id, source.project_id, source.subject, source.text, source.author_role, source.origin, source.occurred_at, source.recorded_at, source.checksum, source.extraction_blocked, source.capture_method]);
        }
        allowedSources.add(source.id);
      }
      const allowedMemories = new Set<string>();
      let imported = 0;
      for (const memory of bundle.memories) {
        const supporting = bundle.evidence.filter(evidence => evidence.memory_id === memory.id);
        if (supporting.some(evidence => !allowedSources.has(evidence.source_id)) || await tombstoned(tx, auth.ownerId, 'memory_content', memoryContent(memory.statement, memory.project_id, memory.subject))) continue;
        const old = await tx.query('SELECT * FROM tk_memories WHERE id=$1', [memory.id]);
        if (old.rows[0]) {
          if (old.rows[0].owner_id !== auth.ownerId || canonical(memoryRow(old.rows[0])) !== canonical(memory)) throw new DomainError(409, 'import_memory_conflict');
        } else {
          const contentKey = hash(canonical([supporting.find(evidence => evidence.revision === 1)?.source_id, normalize(bundle.revisions.find(revision => revision.memory_id === memory.id && revision.revision === 1)?.statement ?? memory.statement), memory.kind, bundle.revisions.find(revision => revision.memory_id === memory.id && revision.revision === 1)?.origin ?? memory.origin, memory.subject]));
          await tx.query(`INSERT INTO tk_memories(id,owner_id,project_id,subject,statement,kind,origin,status,revision,authoritative,effective_at,created_at,updated_at,extractor,content_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [memory.id, auth.ownerId, memory.project_id, memory.subject, memory.statement, memory.kind, memory.origin, memory.status, memory.revision, memory.authoritative, memory.effective_at, memory.created_at, memory.updated_at, memory.extractor, contentKey]);
          imported++;
        }
        allowedMemories.add(memory.id);
      }
      for (const revision of bundle.revisions) if (allowedMemories.has(revision.memory_id)) {
        const old = (await tx.query('SELECT * FROM tk_revisions WHERE memory_id=$1 AND revision=$2', [revision.memory_id, revision.revision])).rows[0];
        if (old && canonical(revisionRow(old)) !== canonical(revision)) throw new DomainError(409, 'import_revision_conflict');
        if (!old) await tx.query(`INSERT INTO tk_revisions(memory_id,revision,statement,origin,status,effective_at,created_at,editor_client_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [revision.memory_id, revision.revision, revision.statement, revision.origin, revision.status, revision.effective_at, revision.created_at, revision.editor_client_id]);
      }
      for (const evidence of bundle.evidence) if (allowedMemories.has(evidence.memory_id)) {
        const old = (await tx.query('SELECT * FROM tk_evidence WHERE memory_id=$1 AND revision=$2 AND source_id=$3', [evidence.memory_id, evidence.revision, evidence.source_id])).rows[0];
        if (old && old.quote !== evidence.quote) throw new DomainError(409, 'import_evidence_conflict');
        if (!old) await tx.query('INSERT INTO tk_evidence(memory_id,revision,source_id,quote) VALUES ($1,$2,$3,$4)', [evidence.memory_id, evidence.revision, evidence.source_id, evidence.quote]);
      }
      return { imported_memories: imported, retained_memories: allowedMemories.size, skipped_memories: bundle.memories.length - allowedMemories.size, snapshot_version: await bump(tx, auth.ownerId) };
    });
  }

  async function processJob(provider: MemoryProvider) {
    const job = await db.transaction(async tx => {
      const pending = (await tx.query(`SELECT * FROM tk_jobs WHERE status='pending' OR (status='processing' AND started_at < now()-interval '10 minutes') ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!pending) return null;
      return (await tx.query("UPDATE tk_jobs SET status='processing',started_at=now(),completed_at=NULL,result=NULL,attempts=attempts+1,error_code=NULL WHERE id=$1 RETURNING *", [pending.id])).rows[0];
    });
    if (!job) return null;
    try {
      const before = (await db.query('SELECT * FROM tk_sources WHERE owner_id=$1 AND id=ANY($2::text[]) AND extraction_blocked=false ORDER BY recorded_at', [job.owner_id, job.source_ids])).rows;
      if (!before.length) {
        await db.query("UPDATE tk_jobs SET status='cancelled',completed_at=now() WHERE id=$1 AND status='processing' AND attempts=$2", [job.id, job.attempts]);
        return { job_id: job.id, status: 'cancelled', accepted: 0, skipped: 0 };
      }
      const extracted = await provider.extract({ events: before.map(source => ({ id: source.event_id, text: source.text, author_role: source.author_role, origin: source.origin, ...(source.occurred_at ? { occurred_at: date(source.occurred_at)! } : {}), client_id: source.client_id })), project_id: job.project_id, subject: job.subject });
      const candidates = parsed(z.array(ExplicitMemorySchema).max(64), extracted.memories);
      return await db.transaction(async tx => {
        await lockOwner(tx, job.owner_id);
        // Lock and re-check this claimed attempt after inference. Deleted jobs
        // and older attempts reclaimed by another worker cannot commit content.
        const live = (await tx.query("SELECT id FROM tk_jobs WHERE id=$1 AND status='processing' AND attempts=$2 FOR UPDATE", [job.id, job.attempts])).rows[0];
        if (!live) return { job_id: job.id, status: 'cancelled', accepted: 0, skipped: candidates.length };
        const current = (await tx.query('SELECT * FROM tk_sources WHERE owner_id=$1 AND id=ANY($2::text[]) AND extraction_blocked=false', [job.owner_id, job.source_ids])).rows;
        if (!current.length) {
          await tx.query("UPDATE tk_jobs SET status='cancelled',completed_at=now(),error_code=NULL,result=NULL WHERE id=$1 AND status='processing' AND attempts=$2", [job.id, job.attempts]);
          return { job_id: job.id, status: 'cancelled', accepted: 0, skipped: candidates.length };
        }
        const available = new Map(current.map(source => [source.event_id, source]));
        const auth: Auth = { ownerId: job.owner_id, clientId: job.client_id, permissions: ['capture'], projects: job.project_id === null ? [] : [job.project_id] };
        let accepted = 0;
        let skipped = 0;
        for (const candidate of candidates) {
          const source = available.get(candidate.source_event_id);
          if (!source) { skipped++; continue; }
          const inserted = await insertMemory(tx, auth, candidate, source, extracted.model ?? null);
          if (inserted.id && !inserted.skipped) accepted++; else skipped++;
        }
        const result = { job_id: job.id, status: 'complete', accepted, skipped, model: extracted.model ?? null, usage: extracted.usage ?? null };
        await tx.query("UPDATE tk_jobs SET status='complete',completed_at=now(),result=$2::jsonb WHERE id=$1 AND status='processing' AND attempts=$3", [job.id, JSON.stringify(result), job.attempts]);
        await bump(tx, job.owner_id);
        return result;
      });
    } catch (error) {
      // Store codes only. Provider error strings can contain private source text or credentials.
      const code = error instanceof DomainError ? error.code : 'provider_or_validation_failed';
      const failed = await db.query("UPDATE tk_jobs SET status='failed',completed_at=now(),error_code=$2 WHERE id=$1 AND status='processing' AND attempts=$3 RETURNING id", [job.id, code, job.attempts]);
      if (!failed.rows.length) return { job_id: job.id, status: 'cancelled', accepted: 0, skipped: 0 };
      return { job_id: job.id, status: 'failed', error_code: code, accepted: 0 };
    }
  }
  async function jobs(auth: Auth) {
    permission(auth, 'read');
    const params: any[] = [];
    const result = await db.query(`SELECT j.id,j.project_id,j.subject,j.status,j.attempts,j.created_at,j.started_at,j.completed_at,j.error_code,j.result FROM tk_jobs j WHERE ${scope(auth, params, 'j')} ORDER BY j.created_at DESC LIMIT 100`, params);
    return { jobs: result.rows };
  }
  return { capture, captureStatus, listCaptures, retryCapture, search: (auth: Auth, filters: unknown) => select(auth, filters, true), list: (auth: Auth, filters: unknown = {}) => select(auth, filters, false), getSource, detail, correct, remove, export: exportData, import: importData, processJob, jobs, processEmbeddings: embeddingIndex.processBatch };
}
