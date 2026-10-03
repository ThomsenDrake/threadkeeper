import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemorySchema } from '../../packages/contracts/src/index.ts';
import { embeddingCorpus } from '../provider-evaluation-corpus.ts';
import { assertLearnedArchiveHistory, assertLearnedDeadlineHistory, assertLearnedDeletionPreview,
  assertLearnedExtraction, directLearnedCase, learnedDetail } from './learned-assertions.ts';

const project = 'synthetic-direct-learned-lifecycle';
const corrected = 'The Lumen demo deadline is October 27, 2026.';
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** One source-only capture, actual background extraction/indexing, and owner edits. */
export async function runLearnedScenarios(options: {
  baseUrl: string; email: string; password: string; signal: AbortSignal;
  sql: (query: string) => Promise<any[]>;
}) {
  const clients: Client[] = [];
  const checks: string[] = [];
  const started = performance.now();
  let cookie = '';
  async function http(path: string, status = 200, body?: unknown, method?: string, token?: string) {
    const response = await fetch(options.baseUrl + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Origin: options.baseUrl, 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { cookie }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]),
    });
    assert.equal(response.status, status, `HTTP ${method ?? 'GET'} ${path} status`);
    return { response, data: await response.json() as any };
  }
  async function tool(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args }, { signal: options.signal, timeout: 120_000 });
    assert(!result.isError, `MCP ${name} failed`);
    assert(result.structuredContent, `MCP ${name} omitted structured data`);
    return result.structuredContent as any;
  }
  async function deniedTool(client: Client, name: string, args: Record<string, unknown>, code: RegExp) {
    const [outcome] = await Promise.allSettled([client.callTool({ name, arguments: args }, { signal: options.signal, timeout: 20_000 })]);
    assert(outcome.status === 'fulfilled' ? outcome.value.isError === true && code.test(JSON.stringify(outcome.value.content))
      : code.test(String(outcome.reason)), `MCP ${name} did not return the expected access denial`);
  }
  async function poll(label: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 180_000;
    do {
      options.signal.throwIfAborted();
      if (await check()) return;
      await delay(250, undefined, { signal: options.signal });
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
  }
  const indexed = () => poll('current native learned embeddings', async () => {
    const rows = await options.sql(`SELECT count(*) AS n FROM tk_memories m WHERE m.status IN ('active','candidate')
      AND NOT EXISTS (SELECT 1 FROM tk_embeddings e WHERE e.memory_id=m.id AND e.revision=m.revision
        AND e.provider_model=${literal(embeddingCorpus.model)} AND e.dimensions=256 AND vector_dims(e.embedding)=256)`);
    return Number(rows[0].n) === 0;
  });
  const recall = (client: Client, query: string) => tool(client, 'context_search', { query, project_id: project, limit: 10 });
  const abortClients = () => { for (const client of clients) void client.close().catch(() => undefined); };
  options.signal.addEventListener('abort', abortClients, { once: true });
  try {
    const login = await http('/api/auth/login', 200, { email: options.email, password: options.password });
    cookie = login.response.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert(cookie, 'owner login omitted cookie');
    const endpoint = (await http('/api/settings/connection')).data.mcp_endpoint;
    assert.equal(endpoint, options.baseUrl + '/mcp');
    const grants = [];
    for (const [index, permissions] of [['a', ['read', 'capture']], ['b', ['read']]] as const) {
      const grant = (await http('/api/clients', 201, { name: `Direct learned client ${index}`, permissions, projects: [project] })).data;
      assert.deepEqual(grant.client.permissions, permissions);
      assert.deepEqual(grant.client.projects, [project]);
      grants.push(grant);
      const client = new Client({ name: `direct-learned-client-${index}`, version: '0.1.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }), { signal: options.signal, timeout: 20_000 });
    }
    const [a, b] = clients;
    assert.notEqual(grants[0].client.id, grants[1].client.id);
    const listed = (await http('/api/clients')).data.clients;
    for (const grant of grants) {
      const persisted = listed.find((client: any) => client.id === grant.client.id);
      assert(persisted);
      assert.deepEqual(persisted.permissions, grant.client.permissions);
      assert.deepEqual(persisted.projects, [project]);
    }
    const deniedCapture = { idempotency_key: 'denied-read-only-capture', project_id: project, events: directLearnedCase.events };
    await deniedTool(b, 'context_capture', deniedCapture, /not found|unknown tool|permission_denied/i);
    const deniedHttpCapture = await http('/api/capture', 403, deniedCapture, 'POST', grants[1].token);
    assert.equal(deniedHttpCapture.data.error, 'permission_denied');
    for (const [client, grant] of [[a, grants[0]], [b, grants[1]]] as const) {
      await deniedTool(client, 'context_search', { query: 'out-of-project private deadline', project_id: 'outside-direct-learned-scope' }, /scope_denied/i);
      const deniedSearch = await http('/api/context/search?query=out-of-project%20private%20deadline&project_id=outside-direct-learned-scope', 403, undefined, undefined, grant.token);
      assert.equal(deniedSearch.data.error, 'scope_denied');
    }
    assert.equal((await options.sql('SELECT id FROM tk_sources')).length, 0, 'Denied capture must not persist a source');
    assert.equal((await options.sql('SELECT id FROM tk_jobs')).length, 0, 'Denied capture must not enqueue inference');
    // Runner accounting also requires exact legitimate per-process request counts;
    // any inference caused by the denied searches/capture fails acceptance.
    checks.push('owner session and two independently scoped MCP transports');

    const events = directLearnedCase.events;
    const input = { idempotency_key: 'direct-learned-lifecycle-capture', project_id: project, events };
    const receipt = await tool(a, 'context_capture', input);
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.memory_ids.length, 0);
    assert(receipt.job_id);
    const repeated = await tool(a, 'context_capture', input);
    assert.equal(repeated.capture_id, receipt.capture_id);
    assert.equal(repeated.job_id, receipt.job_id);
    let completed: any;
    await poll('direct Nemotron extraction', async () => {
      completed = await tool(b, 'context_capture_status', { capture_id: receipt.capture_id });
      assert(!['failed', 'cancelled'].includes(completed.status), `Extraction finished ${completed.status}`);
      return completed.status === 'complete';
    });
    assert.equal(completed.memory_ids.length, 2, 'Expected one deadline and one preference');
    await indexed();
    checks.push('idempotent source-only MCP capture, background direct Nemotron extraction and native Qwen indexing');

    const all = (await http(`/api/memories?project_id=${project}`)).data.memories;
    const sources = [];
    for (const sourceId of receipt.source_ids) sources.push(await tool(b, 'context_get_source', { source_id: sourceId }));
    const { deadline, preference } = assertLearnedExtraction(all, sources, project, grants[0].client.id);
    assert.deepEqual([...completed.memory_ids].sort(), [deadline.id, preference.id].sort());
    assert.deepEqual([...completed.source_ids].sort(), sources.map(source => source.id).sort());
    const originalDeadline = learnedDetail((await http(`/api/memories/${deadline.id}`)).data);
    const deadlineSource = sources.find(source => source.id === deadline.evidence[0].source_id)!;
    const preferenceSource = sources.find(source => source.id === preference.evidence[0].source_id)!;
    assert.deepEqual(originalDeadline.memory, MemorySchema.parse(deadline));
    assert.deepEqual(originalDeadline.sources, [deadlineSource]);
    assert.equal(originalDeadline.revisions.length, 1);
    assert.equal(originalDeadline.revisions[0].revision, 1);
    assert.equal(originalDeadline.revisions[0].memory_id, deadline.id);
    assert.equal(originalDeadline.revisions[0].statement, deadline.statement);
    assert.equal(originalDeadline.revisions[0].origin, deadline.origin);
    assert.equal(originalDeadline.revisions[0].status, deadline.status);
    assert.equal(originalDeadline.revisions[0].effective_at, deadline.effective_at);
    assert.equal(originalDeadline.revisions[0].editor_client_id, grants[0].client.id);
    assert.equal(originalDeadline.revisions[0].extractor, deadline.extractor);
    assert.deepEqual(originalDeadline.evidence, [{ memory_id: deadline.id, revision: 1, source_id: deadlineSource.id, quote: deadline.evidence[0].quote }]);
    const learnedQueries = [];
    for (const [query, target] of [[embeddingCorpus.queries[0].text, deadline.id], [embeddingCorpus.queries[1].text, preference.id]]) {
      const result = await recall(b, query);
      assert.equal(result.coverage.retrieval, 'postgresql_hybrid');
      assert.equal(result.coverage.semantic_search, 'enabled');
      assert.equal(result.memories[0]?.id, target, 'Learned paraphrase should rank its relevant record first');
      const lexical = await options.sql(`SELECT id FROM tk_memories WHERE status='active' AND
        (search_vector @@ websearch_to_tsquery('english',${literal(query)}) OR position(lower(${literal(query)}) in lower(statement))>0)`);
      assert.equal(lexical.length, 0, 'The paraphrase query unexpectedly matches full-text retrieval');
      learnedQueries.push({ query, relevant_rank: 1, lexical_matches: 0 });
    }
    checks.push('independent semantic paraphrase recall ranks the learned deadline and preference first with exact source provenance');

    const changed = (await http(`/api/memories/${deadline.id}`, 200, { statement: corrected, expected_revision: deadline.revision }, 'PATCH')).data.memory;
    assert.equal(changed.revision, deadline.revision + 1);
    assert.equal(changed.authoritative, true);
    assert.equal(changed.statement, corrected);
    assertLearnedDeadlineHistory((await http(`/api/memories/${deadline.id}`)).data, originalDeadline, changed);
    assert.deepEqual(await tool(b, 'context_get_source', { source_id: deadlineSource.id }), { ...deadlineSource, extraction_blocked: true });
    await http(`/api/memories/${deadline.id}`, 409, { statement: deadline.statement, expected_revision: deadline.revision }, 'PATCH');
    const preview = assertLearnedDeletionPreview((await http(`/api/memories/${preference.id}/deletion-preview`)).data,
      preference, preferenceSource, deadlineSource.id, receipt.job_id);
    const removed = (await http(`/api/memories/${preference.id}`, 200, { expected_revision: preference.revision, preview_hash: preview.preview_hash }, 'DELETE')).data;
    assert.deepEqual(removed.deleted_memory_ids, [preference.id]);
    assert.deepEqual(removed.deleted_source_ids, [preferenceSource.id]);
    assert.deepEqual(removed.deleted_job_ids, [receipt.job_id]);
    assert.equal(removed.deleted_count, 1);
    // Fresh receipt keys exercise tombstones rather than immutable receipt replay.
    // Explicitly empty memories ensure these negative checks cannot enqueue
    // inference even if a deletion fence regresses and admission unexpectedly succeeds.
    for (const [name, event] of [
      ['identity', { ...events[1], text: 'A replacement for an already forgotten source identity.' }],
      ['content', { ...events[1], id: 'forgotten-content-replay', text: `  ${preferenceSource.text.toUpperCase()}\n` }],
    ] as const) {
      const replay = await http('/api/capture', 410, { idempotency_key: `forgotten-${name}-replay`, project_id: project,
        events: [event], explicit_memories: [] }, 'POST', grants[0].token);
      assert.equal(replay.data.error, 'deleted_source');
    }
    await http(`/api/sources/${preference.evidence[0].source_id}`, 404, undefined, undefined, grants[1].token);
    await http(`/api/memories/${preference.id}`, 404);
    const forbidden = await b.callTool({ name: 'context_get_source', arguments: { source_id: preference.evidence[0].source_id } }, { signal: options.signal, timeout: 20_000 });
    assert(forbidden.isError, 'Forgotten source remains readable through MCP');
    await indexed();
    for (const client of [a, b]) {
      const result = await recall(client, embeddingCorpus.queries[0].text);
      assert.equal(result.coverage.retrieval, 'postgresql_hybrid');
      assert.deepEqual(result.memories.map((memory: any) => memory.statement), [corrected]);
      const memory = result.memories[0];
      assert.equal(memory.authoritative, true);
      assert.equal(memory.evidence[0].capture_method, 'profile_correction');
      assert.equal(memory.evidence[0].quote, corrected);
    }
    const preferenceRecall = await recall(b, embeddingCorpus.queries[1].text);
    assert(!preferenceRecall.memories.some((memory: any) => memory.id === preference.id || /short paragraphs/i.test(memory.statement)));
    const retained = assertLearnedDeadlineHistory((await http(`/api/memories/${deadline.id}`)).data, originalDeadline, changed);
    assert.deepEqual(await tool(b, 'context_get_source', { source_id: deadlineSource.id }), { ...deadlineSource, extraction_blocked: true });
    assert.deepEqual((await http(`/api/sources/${deadlineSource.id}`, 200, undefined, undefined, grants[1].token)).data,
      { ...deadlineSource, extraction_blocked: true });
    const archive = assertLearnedArchiveHistory((await http('/api/export')).data, retained, { memory: preference, source: preferenceSource });
    assert(!JSON.stringify(archive).includes('short paragraphs'));
    const remainingVectors = await options.sql('SELECT memory_id,revision,provider_model,dimensions FROM tk_embeddings');
    assert.equal(remainingVectors.length, 1);
    assert.equal(remainingVectors[0].memory_id, deadline.id);
    assert.equal(remainingVectors[0].revision, changed.revision);
    assert.equal((await options.sql('SELECT id FROM tk_jobs')).length, 0, 'Forgotten evidence must remove the shared extraction job payload');
    checks.push('revision-checked authoritative correction, graph-preview forgetting, fresh independent hybrid recall and export/vector/job cleanup');
    return { checks, queries: learnedQueries, extraction: { accepted: 2, model: 'nvidia/Nemotron-3_5-Lightning' },
      surviving_memory: { statement: corrected, revision: changed.revision, authoritative: true }, elapsed_ms: Math.round(performance.now() - started) };
  } finally {
    options.signal.removeEventListener('abort', abortClients);
    const outcomes = await Promise.allSettled(clients.map(client => client.close()));
    assert(outcomes.every(outcome => outcome.status === 'fulfilled'), 'MCP client cleanup failed');
  }
}
