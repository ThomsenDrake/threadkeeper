import { DomainError, type Database } from './index.ts';
import { sourceIdentity, sourceContent, memoryContent } from './hashing.ts';

export type DeletionRecords = { memories: any[]; sources: any[]; revisions: any[]; evidence: any[]; jobs: any[] };

// One graph policy for owner previews and isolated operational reconciliation.
// The caller holds the owner lock and owns the surrounding transaction.
export async function connectedDeletionRecords(tx: Database, ownerId: string,
  seeds: { memory_ids: string[]; source_ids: string[] }): Promise<DeletionRecords> {
  const allSources = (await tx.query('SELECT * FROM tk_sources WHERE owner_id=$1 ORDER BY id', [ownerId])).rows;
  const allMemories = (await tx.query('SELECT * FROM tk_memories WHERE owner_id=$1 ORDER BY id', [ownerId])).rows;
  const allRevisions = (await tx.query(`SELECT r.* FROM tk_revisions r JOIN tk_memories m ON m.id=r.memory_id
    WHERE m.owner_id=$1 ORDER BY r.memory_id,r.revision`, [ownerId])).rows;
  const crossOwner = await tx.query(`SELECT 1 FROM tk_evidence e JOIN tk_memories m ON m.id=e.memory_id
    JOIN tk_sources s ON s.id=e.source_id WHERE m.owner_id<>s.owner_id AND (m.owner_id=$1 OR s.owner_id=$1) LIMIT 1`, [ownerId]);
  if (crossOwner.rows.length) throw new DomainError(409, 'invalid_deletion_graph');
  const allEvidence = (await tx.query(`SELECT e.* FROM tk_evidence e JOIN tk_memories m ON m.id=e.memory_id
    JOIN tk_sources s ON s.id=e.source_id WHERE m.owner_id=$1 AND s.owner_id=$1
    ORDER BY e.memory_id,e.revision,e.source_id`, [ownerId])).rows;
  const memoriesById = new Map(allMemories.map(memory => [memory.id, memory]));
  const sourcesById = new Map(allSources.map(source => [source.id, source]));
  const sourceCopies = new Map<string, string[]>(), assertions = new Map<string, string[]>();
  const memoryAssertions = new Map<string, string[]>(), memorySources = new Map<string, string[]>(), sourceMemories = new Map<string, string[]>();
  function link(map: Map<string, string[]>, key: string, value: string) {
    const values = map.get(key) ?? []; values.push(value); map.set(key, values);
  }
  for (const source of allSources) link(sourceCopies, sourceContent(source.text), source.id);
  for (const revision of allRevisions) {
    const memory = memoriesById.get(revision.memory_id)!;
    const assertion = memoryContent(revision.statement, memory.project_id, memory.subject);
    link(assertions, assertion, memory.id); link(memoryAssertions, memory.id, assertion);
  }
  for (const evidence of allEvidence) {
    link(memorySources, evidence.memory_id, evidence.source_id);
    link(sourceMemories, evidence.source_id, evidence.memory_id);
  }
  const memoryIds = new Set<string>(), sourceIds = new Set<string>();
  const queue: Array<{ kind: 'memory' | 'source'; id: string }> = [];
  function include(kind: 'memory' | 'source', id: string) {
    if (!(kind === 'memory' ? memoriesById : sourcesById).has(id)) return;
    const ids = kind === 'memory' ? memoryIds : sourceIds;
    if (!ids.has(id)) { ids.add(id); queue.push({ kind, id }); }
  }
  for (const id of seeds.memory_ids) include('memory', id);
  for (const id of seeds.source_ids) include('source', id);
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (item.kind === 'memory') {
      for (const id of memorySources.get(item.id) ?? []) include('source', id);
      for (const assertion of memoryAssertions.get(item.id) ?? []) {
        for (const id of assertions.get(assertion) ?? []) include('memory', id);
      }
    } else {
      for (const id of sourceCopies.get(sourceContent(sourcesById.get(item.id)!.text)) ?? []) include('source', id);
      for (const id of sourceMemories.get(item.id) ?? []) include('memory', id);
    }
  }
  const jobs = (await tx.query('SELECT id,status,source_ids FROM tk_jobs WHERE owner_id=$1 AND source_ids && $2::text[] ORDER BY id', [ownerId, [...sourceIds]])).rows;
  return { memories: allMemories.filter(row => memoryIds.has(row.id)), sources: allSources.filter(row => sourceIds.has(row.id)),
    revisions: allRevisions.filter(row => memoryIds.has(row.memory_id)), evidence: allEvidence.filter(row => memoryIds.has(row.memory_id)), jobs };
}

export async function applyDeletionRecords(tx: Database, ownerId: string, records: DeletionRecords) {
  const memoryIds = records.memories.map(row => row.id), sourceIds = records.sources.map(row => row.id);
  const memories = new Map(records.memories.map(row => [row.id, row]));
  const tombstones: Array<[string, string]> = records.sources.flatMap(source => [
    ['source_identity', sourceIdentity(source.client_id, source.event_id)], ['source_content', sourceContent(source.text)],
  ] as Array<[string, string]>);
  for (const revision of records.revisions) {
    const memory = memories.get(revision.memory_id)!;
    tombstones.push(['memory_content', memoryContent(revision.statement, memory.project_id, memory.subject)]);
  }
  for (const [kind, digest] of tombstones) await tx.query('INSERT INTO tk_tombstones(owner_id,kind,hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ownerId, kind, digest]);
  await tx.query('DELETE FROM tk_jobs WHERE owner_id=$1 AND source_ids && $2::text[]', [ownerId, sourceIds]);
  await tx.query('DELETE FROM tk_memories WHERE owner_id=$1 AND id=ANY($2::text[])', [ownerId, memoryIds]);
  await tx.query('DELETE FROM tk_sources WHERE owner_id=$1 AND id=ANY($2::text[])', [ownerId, sourceIds]);
  return { deleted_memory_ids: memoryIds, deleted_source_ids: sourceIds, deleted_job_ids: records.jobs.map(row => row.id),
    deleted_count: memoryIds.length, blast_radius: 'whole_connected_source_events' as const };
}
