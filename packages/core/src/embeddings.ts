import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './index.ts';

/** A structural interface: the core does not depend on any hosted provider. */
export type EmbeddingProvider = {
  config: { baseUrl: string; modelId: string; dimensions?: number };
  embed(texts: string[]): Promise<{ vectors: number[][]; dimensions: number; model: string }>;
};

type Capability = {
  enabled: boolean;
  reason: string;
  version?: string;
  dimensions?: number;
  index: 'exact';
};

const preprocessingVersion = 'raw-statement-unit-v1';

// pgvector stores float32 values. Validate after conversion too: a finite JS
// number can overflow, or an entire vector can underflow to zero, in float32.
function validateVectors(result: Awaited<ReturnType<EmbeddingProvider['embed']>>, count: number, dimensions: number, model: string) {
  if (!result || result.model !== model || result.dimensions !== dimensions
    || !Array.isArray(result.vectors) || result.vectors.length !== count) throw new Error('invalid_embedding_response');
  return Array.from(result.vectors, vector => {
    if (!Array.isArray(vector) || vector.length !== dimensions) throw new Error('invalid_embedding_response');
    const values = Array.from(vector, value => {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_embedding_response');
      const stored = Math.fround(value);
      if (!Number.isFinite(stored)) throw new Error('invalid_embedding_response');
      return stored;
    });
    const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    if (scale === 0) throw new Error('invalid_embedding_response');
    // Cosine is scale invariant. Normalize safely before storage: pgvector's
    // float32 norm arithmetic can produce NaN for very large or tiny vectors.
    const norm = Math.sqrt(values.reduce((sum, value) => sum + (value / scale) ** 2, 0));
    return values.map(value => Math.fround((value / scale) / norm));
  });
}

/**
 * Optional, rebuildable derived data. Workers are trusted database operators;
 * client retrieval still applies authorization in the store's canonical query.
 */
export function createEmbeddingIndex(db: Database, provider?: EmbeddingProvider) {
  const configuredDimensions = provider?.config.dimensions;
  const dimensions = Number.isInteger(configuredDimensions) && configuredDimensions! > 0
    && configuredDimensions! <= 16000 ? configuredDimensions! : null;
  const spaceId = provider && dimensions !== null
    ? createHash('sha256').update(JSON.stringify([
      provider.config.baseUrl.replace(/\/+$/, ''), provider.config.modelId, dimensions, preprocessingVersion,
    ])).digest('hex') : null;
  let capabilityPromise: Promise<Capability> | undefined;

  async function inspectCapability(): Promise<Capability> {
    const base = { index: 'exact' as const, ...(dimensions === null ? {} : { dimensions }) };
    if (!provider) return { ...base, enabled: false, reason: 'not_enabled' };
    if (configuredDimensions === undefined) return { ...base, enabled: false, reason: 'embedding_dimensions_required' };
    if (dimensions === null) return { ...base, enabled: false, reason: 'invalid_embedding_dimensions' };
    let version: string;
    try {
      const extension = (await db.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0];
      if (!extension) return { ...base, enabled: false, reason: 'pgvector_unavailable' };
      version = extension.extversion;
    } catch {
      return { ...base, enabled: false, reason: 'pgvector_unavailable' };
    }
    try {
      // Also verifies that the optional migration has run. No user data is read.
      await db.query('SELECT memory_id,revision,space_id,dimensions,embedding FROM tk_embeddings WHERE false');
      await db.query('SELECT memory_id,revision,space_id,attempts,claim_token,lease_until,next_attempt_at FROM tk_embedding_attempts WHERE false');
    } catch {
      return { ...base, version, enabled: false, reason: 'embedding_storage_unavailable' };
    }
    try {
      // Probe the installed extension rather than assuming its dimension/index
      // limits. Exact cosine supports spaces beyond the usual ANN vector limit.
      const probe = JSON.stringify([1, ...Array<number>(dimensions - 1).fill(0)]);
      const row = (await db.query(`SELECT vector_dims($1::vector(${dimensions})) AS dimensions,
        ($1::vector(${dimensions}) <=> $1::vector(${dimensions})) AS distance`, [probe])).rows[0];
      if (Number(row?.dimensions) !== dimensions || !Number.isFinite(Number(row?.distance))
        || Math.abs(Number(row.distance)) > 0.000001) throw new Error('incompatible_vector');
    } catch {
      return { ...base, version, enabled: false, reason: 'pgvector_incompatible_dimensions' };
    }
    return { ...base, version, enabled: true, reason: 'enabled' };
  }

  // Extension/schema changes require a service restart. Provider failures do
  // not change this capability, so a subsequent request can recover normally.
  function capability() {
    return capabilityPromise ??= inspectCapability();
  }

  async function query(text: string): Promise<{ vector: number[] | null; reason: string }> {
    const available = await capability();
    if (!available.enabled) return { vector: null, reason: available.reason };
    try {
      const result = await provider!.embed([text]);
      const [vector] = validateVectors(result, 1, dimensions!, provider!.config.modelId);
      return { vector, reason: 'enabled' };
    } catch {
      // Never expose provider error text: it can contain private input or keys.
      return { vector: null, reason: 'provider_unavailable' };
    }
  }

  type BatchReport = { status: string; indexed: number; skipped: number; reason?: string;
    pending?: number; deferred?: number; retry_after_ms?: number };

  const missingVectors = `m.status IN ('active','candidate') AND NOT EXISTS (
    SELECT 1 FROM tk_embeddings e WHERE e.memory_id=m.id AND e.revision=m.revision
      AND e.space_id=$1 AND e.dimensions=$2
  )`;
  const sameAttempt = 'a.revision=m.revision AND a.space_id=$1';
  const eligibleAttempt = `(a.memory_id IS NULL OR NOT (${sameAttempt})
    OR ((a.lease_until IS NULL OR a.lease_until<=clock_timestamp()) AND a.next_attempt_at<=clock_timestamp()))`;

  async function remaining() {
    const row = (await db.query(`SELECT count(*) AS pending,
      count(*) FILTER (WHERE NOT ${eligibleAttempt}) AS deferred,
      COALESCE(ceil(min(CASE WHEN a.memory_id IS NULL OR NOT (${sameAttempt}) THEN 0
        ELSE GREATEST(0,EXTRACT(EPOCH FROM (
          GREATEST(COALESCE(a.lease_until,'-infinity'::timestamptz),a.next_attempt_at)-clock_timestamp()))*1000)
      END)),0) AS retry_after_ms
      FROM tk_memories m LEFT JOIN tk_embedding_attempts a ON a.memory_id=m.id
      WHERE ${missingVectors}`, [spaceId, dimensions])).rows[0];
    return { pending: Number(row.pending), deferred: Number(row.deferred), retry_after_ms: Number(row.retry_after_ms) };
  }

  async function processBatch(limit = 16): Promise<BatchReport> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new RangeError('embedding_batch_limit_must_be_1_to_64');
    const available = await capability();
    if (!available.enabled) return { status: 'disabled', reason: available.reason, indexed: 0, skipped: 0, pending: 0, deferred: 0, retry_after_ms: 0 };
    let pending: any[];
    try {
      pending = await db.transaction(async tx => {
        // Separate from the recovery gate's shared session lock. The short
        // claim lock keeps workers from paying for the same pending revision.
        await tx.query('SELECT pg_advisory_xact_lock($1,$2)', [141422, 3]);
        const rows = (await tx.query(`SELECT m.id,m.owner_id,m.revision,m.statement,m.status,
          CASE WHEN ${sameAttempt} THEN a.attempts ELSE 0 END AS prior_attempts
          FROM tk_memories m LEFT JOIN tk_embedding_attempts a ON a.memory_id=m.id
          WHERE ${missingVectors} AND ${eligibleAttempt}
          ORDER BY CASE WHEN ${sameAttempt} THEN a.next_attempt_at ELSE m.updated_at END,m.id
          LIMIT $3`, [spaceId, dimensions, limit])).rows;
        // A rejected fresh batch is retried one row at a time. Healthy peers
        // and later captures can progress without repeating a poison batch;
        // even an outage costs only one provider request per worker cycle.
        const selected = rows[0]?.prior_attempts > 0 ? rows.slice(0, 1) : rows.filter(row => Number(row.prior_attempts) === 0);
        const claimed: any[] = [];
        for (const row of selected) {
          const token = randomUUID();
          const attempt = (await tx.query(`INSERT INTO tk_embedding_attempts
            (memory_id,revision,space_id,attempts,claim_token,lease_until,next_attempt_at)
            VALUES ($1,$2,$3,1,$4,clock_timestamp()+interval '10 minutes',clock_timestamp())
            ON CONFLICT (memory_id) DO UPDATE SET
              attempts=CASE WHEN tk_embedding_attempts.revision=EXCLUDED.revision
                AND tk_embedding_attempts.space_id=EXCLUDED.space_id
                THEN LEAST(tk_embedding_attempts.attempts,30)+1 ELSE 1 END,
              revision=EXCLUDED.revision,space_id=EXCLUDED.space_id,
              claim_token=EXCLUDED.claim_token,lease_until=EXCLUDED.lease_until,next_attempt_at=clock_timestamp()
            RETURNING attempts`, [row.id, row.revision, spaceId, token])).rows[0];
          claimed.push({ ...row, claim_token: token, attempts: Number(attempt.attempts) });
        }
        return claimed;
      });
    } catch {
      return { status: 'storage_failed', reason: 'storage_unavailable', indexed: 0, skipped: 0 };
    }
    if (!pending.length) {
      try {
        const state = await remaining();
        return { status: state.pending ? 'deferred' : 'idle', indexed: 0, skipped: 0, ...state };
      } catch { return { status: 'storage_failed', reason: 'storage_unavailable', indexed: 0, skipped: 0 }; }
    }
    let vectors: number[][];
    try {
      // Network calls run outside database transactions and owner locks.
      vectors = validateVectors(await provider!.embed(pending.map(row => row.statement)), pending.length, dimensions!, provider!.config.modelId);
    } catch {
      try {
        for (const row of pending) {
          const retryMs = Math.min(30_000 * 2 ** (row.attempts - 1), 3_600_000);
          await db.query(`UPDATE tk_embedding_attempts SET claim_token=NULL,lease_until=NULL,
            next_attempt_at=clock_timestamp()+($3::double precision*interval '1 millisecond')
            WHERE memory_id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()`, [row.id, row.claim_token, retryMs]);
        }
        return { status: 'provider_failed', reason: 'provider_unavailable', indexed: 0, skipped: pending.length, ...await remaining() };
      } catch { return { status: 'storage_failed', reason: 'storage_unavailable', indexed: 0, skipped: pending.length }; }
    }
    let indexed = 0;
    let skipped = 0;
    try {
      for (const [index, before] of pending.entries()) {
        const committed = await db.transaction(async tx => {
          // Corrections and deletion use this same owner lock. Re-read after
          // inference so an in-flight worker cannot recreate obsolete content.
          const owner = (await tx.query('SELECT id FROM tk_owners WHERE id=$1 FOR UPDATE', [before.owner_id])).rows[0];
          if (!owner) return false;
          const current = (await tx.query('SELECT revision,statement,status FROM tk_memories WHERE id=$1 AND owner_id=$2 FOR UPDATE', [before.id, before.owner_id])).rows[0];
          if (!current || Number(current.revision) !== Number(before.revision)
            || current.statement !== before.statement || current.status !== before.status
            || !['active', 'candidate'].includes(current.status)) {
            await tx.query('DELETE FROM tk_embedding_attempts WHERE memory_id=$1 AND claim_token=$2', [before.id, before.claim_token]);
            return false;
          }
          const claim = (await tx.query(`SELECT memory_id FROM tk_embedding_attempts
            WHERE memory_id=$1 AND revision=$2 AND space_id=$3 AND claim_token=$4
            FOR UPDATE`, [before.id, before.revision, spaceId, before.claim_token])).rows[0];
          if (!claim) return false;
          // Check wall-clock expiry after every row lock: transaction-start
          // time and a predicate evaluated before waiting can admit late work.
          if (!(await tx.query(`SELECT memory_id FROM tk_embedding_attempts
            WHERE memory_id=$1 AND lease_until>clock_timestamp()`, [before.id])).rows.length) return false;
          await tx.query(`INSERT INTO tk_embeddings(memory_id,revision,provider_model,preprocessing_version,embedding,space_id,dimensions)
            VALUES ($1,$2,$3,$4,$5::vector,$6,$7)
            ON CONFLICT (memory_id) DO UPDATE SET revision=EXCLUDED.revision,
              provider_model=EXCLUDED.provider_model,preprocessing_version=EXCLUDED.preprocessing_version,
              embedding=EXCLUDED.embedding,space_id=EXCLUDED.space_id,dimensions=EXCLUDED.dimensions`,
          [before.id, before.revision, provider!.config.modelId, preprocessingVersion, JSON.stringify(vectors[index]), spaceId, dimensions]);
          await tx.query('DELETE FROM tk_embedding_attempts WHERE memory_id=$1 AND claim_token=$2', [before.id, before.claim_token]);
          return true;
        });
        if (committed) indexed++; else skipped++;
      }
    } catch {
      return { status: 'storage_failed', reason: 'storage_unavailable', indexed, skipped: pending.length - indexed };
    }
    try { return { status: 'complete', indexed, skipped, ...await remaining() }; }
    catch { return { status: 'storage_failed', reason: 'storage_unavailable', indexed, skipped }; }
  }

  return { capability, query, processBatch, spaceId, dimensions };
}
