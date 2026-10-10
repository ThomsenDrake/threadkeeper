import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_MODEL_ID } from '../../packages/providers/src/index.ts';
import { FIXTURE_EMBEDDING_MODEL, FIXTURE_REJECTED_EMBEDDING_MARKER } from './provider-fixture.ts';

const deadline = 'The Atlas deadline is 20 October 2026.';
const correctedDeadline = 'The Atlas deadline is 27 October 2026.';
const preference = 'Use short paragraphs in my writing.';
const inference = 'The writer may favor concise explanations.';
const correctedInference = 'Use concise explanations when discussing my writing.';
const semanticQuery = 'milestones and prose style';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const statements = (result: any): string[] => result.memories.map((memory: any) => memory.statement).sort();
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Integration assertion: ${message}`);
}
function sameStatements(result: any, expected: string[], message: string) {
  ensure(JSON.stringify(statements(result)) === JSON.stringify([...expected].sort()), message);
}
function sameIds(actual: string[], expected: string[], message: string) {
  ensure(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), message);
}

/** Real API, MCP transports, provider HTTP adapter and worker; synthetic data only. */
export async function runScenarios(options: {
  baseUrl: string; controlUrl: string; email: string; password: string;
  sql: (query: string) => Promise<any[]>;
  signal?: AbortSignal;
}): Promise<string[]> {
  const origin = options.baseUrl;
  const clients: Client[] = [];
  const passed: string[] = [];
  const sql = options.sql;
  let cookie = '';
  let mcpEndpoint = '';
  const requestSignal = (timeout: number, cleanup = false) => options.signal && !cleanup
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const abortClients = () => {
    for (const client of clients) void client.close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortClients, { once: true });
  async function stage(name: string, run: () => Promise<void>) {
    console.info(`Integration stage: ${name}`);
    try { await run(); }
    catch (error) {
      // SDK/network errors can contain request headers. Report only our static
      // assertions and stage labels, never arbitrary transport/provider bodies.
      const reason = error instanceof Error && error.message.startsWith('Integration ')
        ? error.message : `${error instanceof TypeError ? 'TypeError' : 'Unexpected error'} during transport or database operation`;
      throw new Error(`${name}: ${reason}`);
    }
    console.info(`PASS: ${name}`);
    passed.push(name);
  }
  async function poll(label: string, test: () => Promise<boolean>, timeout = 40_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      options.signal?.throwIfAborted();
      if (await test()) return;
      await delay(100, undefined, { signal: options.signal });
    }
    throw new Error(`Integration timeout: ${label}`);
  }
  async function request(path: string, input: {
    method?: string; body?: unknown; token?: string; session?: string;
  } = {}) {
    let response: Response;
    try {
      response = await fetch(options.baseUrl + path, {
        method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
        headers: {
          Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json',
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : { cookie: input.session ?? cookie }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: requestSignal(20_000),
      });
    } catch { throw new Error(`Integration HTTP request failed: ${path.split('?')[0]}`); }
    let data: any;
    try { data = await response.json(); }
    catch { throw new Error(`Integration invalid HTTP JSON: ${path.split('?')[0]} (status ${response.status})`); }
    return { response, data };
  }
  async function expected(path: string, status: number, input: Parameters<typeof request>[1] = {}) {
    const result = await request(path, input);
    ensure(result.response.status === status, `${path.split('?')[0]} expected HTTP ${status}, got ${result.response.status}`);
    return result;
  }
  async function control(path: string, body?: unknown, cleanup = false) {
    const response = await fetch(options.controlUrl + '/control/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal(5_000, cleanup),
    });
    ensure(response.ok, `fixture control ${path} returned HTTP ${response.status}`);
    return await response.json() as any;
  }
  async function login(email: string) {
    const result = await expected('/api/auth/login', 200, { body: { email, password: options.password } });
    const session = result.response.headers.get('set-cookie')?.split(';')[0];
    ensure(session, 'profile login did not issue a session cookie');
    return { session, user: result.data.user };
  }
  async function grant(name: string, permissions: string[], projects: string[] | null, session = cookie) {
    const result = await expected('/api/clients', 201, { body: { name, permissions, projects }, session });
    ensure(typeof result.data.token === 'string' && result.data.client?.id, 'client grant response was incomplete');
    return result.data as { token: string; client: { id: string; created_at: string; last_used_at: string | null } };
  }
  async function connect(name: string, token: string) {
    options.signal?.throwIfAborted();
    const client = new Client({ name, version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    clients.push(client);
    // Feed the documented remote connection object directly to the SDK. The
    // endpoint comes from owner configuration, rather than a guessed client URL.
    const config = { url: mcpEndpoint, headers: { Authorization: `Bearer ${token}` } };
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    }), { signal: options.signal, timeout: 20_000 });
    return client;
  }
  async function tool(client: Client, name: string, args: Record<string, unknown>) {
    options.signal?.throwIfAborted();
    const result = await client.callTool({ name, arguments: args }, { signal: options.signal, timeout: 20_000 });
    ensure(!result.isError, `MCP ${name} returned an error`);
    ensure(result.structuredContent && typeof result.structuredContent === 'object', `MCP ${name} omitted structured data`);
    return result.structuredContent as any;
  }
  const recall = (client: Client, query = semanticQuery, filters: Record<string, unknown> = {}) =>
    tool(client, 'context_search', { query, ...filters });
  const captureStatus = (client: Client, captureId: string) =>
    tool(client, 'context_capture_status', { capture_id: captureId });
  async function toolDenied(client: Client, name: string, args: Record<string, unknown>, code?: RegExp) {
    options.signal?.throwIfAborted();
    const [result] = await Promise.allSettled([client.callTool({ name, arguments: args }, { signal: options.signal, timeout: 20_000 })]);
    ensure(result.status === 'fulfilled' ? result.value.isError === true && (!code || code.test(JSON.stringify(result.value.content)))
      : (code ?? /not found|unknown tool|scope_denied|permission_denied|403|401|Unauthorized/i).test(String(result.reason)),
    `MCP ${name} did not return the expected access denial`);
  }
  function capture(id: string, text: string, project = 'atlas', explicit = true) {
    return {
      idempotency_key: id, project_id: project,
      events: [{ id, text, author_role: 'user', origin: 'user_explicit' }],
      ...(explicit ? { explicit_memories: [{ statement: text, kind: 'fact', source_event_id: id, quote: text, origin: 'user_explicit' }] } : {}),
    };
  }
  async function job(id: string, status: string) {
    let row: any;
    await poll(`worker job ${status}`, async () => {
      row = (await sql(`SELECT status,result,error_code,attempts FROM tk_jobs WHERE id=${literal(id)}`))[0];
      if (row && ['complete', 'failed', 'cancelled'].includes(row.status) && row.status !== status) {
        throw new Error(`Integration assertion: worker expected ${status}, got ${row.status}`);
      }
      return row?.status === status;
    });
    return row;
  }
  async function indexed() {
    await poll('all current memories indexed', async () => {
      const row = (await sql(`SELECT count(*) AS n FROM tk_memories m
        WHERE m.status='active' AND NOT EXISTS
        (SELECT 1 FROM tk_embeddings e WHERE e.memory_id=m.id AND e.revision=m.revision
          AND e.provider_model=${literal(FIXTURE_EMBEDDING_MODEL)} AND e.dimensions=3
          AND vector_dims(e.embedding)=3)`))[0];
      return Number(row.n) === 0;
    });
  }
  const patch = async (memory: any, statement: string) => (await expected(`/api/memories/${memory.id}`, 200, {
    method: 'PATCH', body: { statement, expected_revision: memory.revision },
  })).data.memory;
  const remove = async (memory: any) => expected(`/api/memories/${memory.id}`, 200, {
    method: 'DELETE', body: { expected_revision: memory.revision, preview_hash: (await expected(`/api/memories/${memory.id}/deletion-preview`, 200)).data.preview_hash },
  });

  try {
    await control('reset', {});
    let a!: Client, b!: Client;
    let grantA!: Awaited<ReturnType<typeof grant>>, grantB!: Awaited<ReturnType<typeof grant>>;
    let ownerId = '', dl: any, pref: any, corrected: any, correctionSourceId = '';
    await stage('profile and two independently authenticated MCP clients', async () => {
      const owner = await login(options.email);
      cookie = owner.session; ownerId = owner.user.id;
      mcpEndpoint = (await expected('/api/settings/connection', 200)).data.mcp_endpoint;
      ensure(mcpEndpoint === new URL('/mcp', origin).href, 'connection guidance did not use the exact configured application origin');
      grantA = await grant('Integration Client A', ['read', 'capture'], ['atlas']);
      grantB = await grant('Integration Client B', ['read'], ['atlas']);
      ensure(grantA.token !== grantB.token && grantA.client.id !== grantB.client.id, 'client grants were not independent');
      ensure(grantA.client.created_at && grantB.client.created_at
        && grantA.client.last_used_at === null && grantB.client.last_used_at === null,
      'credential issuance was confused with observed authenticated use');
      a = await connect('integration-client-a', grantA.token);
      b = await connect('integration-client-b', grantB.token);
      ensure((await a.listTools(undefined, { signal: options.signal, timeout: 20_000 })).tools.some(tool => tool.name === 'context_capture'), 'Client A cannot capture');
      ensure(!(await b.listTools(undefined, { signal: options.signal, timeout: 20_000 })).tools.some(tool => tool.name === 'context_capture'), 'read-only Client B exposes capture');
      const connectedClients = (await expected('/api/clients', 200)).data.clients;
      for (const issued of [grantA.client, grantB.client]) {
        const connected = connectedClients.find((client: any) => client.id === issued.id);
        ensure(connected?.created_at === issued.created_at && connected.last_used_at
          && Date.parse(connected.last_used_at) >= Date.parse(connected.created_at),
        'authenticated SDK requests did not report observed client use separately from issuance');
      }
      await expected('/health', 200);
      const profile = await fetch(options.baseUrl, { headers: { Host: new URL(origin).host }, signal: requestSignal(20_000) });
      ensure(profile.ok && (await profile.text()).includes('<div id="root">'), 'container did not serve the built profile');
    });
    await stage('worker HTTP extraction and native pgvector hybrid recall', async () => {
      await control('configure', { holdChat: true });
      const captured = await tool(a, 'context_capture', {
        idempotency_key: 'integration-central', project_id: 'atlas',
        events: [
          { id: 'deadline-v1', text: deadline, author_role: 'user', origin: 'user_explicit' },
          { id: 'writing-v1', text: preference, author_role: 'user', origin: 'user_explicit' },
        ],
      });
      ensure(captured.capture_id && captured.status === 'pending' && captured.job_id && captured.memory_ids.length === 0, 'capture did not queue source-only extraction');
      await poll('held initial extraction request', async () => (await control('status')).heldChat > 0, 20_000);
      const processing = await captureStatus(a, captured.capture_id);
      ensure(processing.status === 'processing' && processing.job?.id === captured.job_id
        && processing.job.status === 'processing' && processing.job.attempts === 1
        && processing.job.started_at && processing.job.completed_at === null
        && processing.job.accepted === null && processing.job.skipped === null && !processing.can_retry,
      'MCP status did not expose the live processing job');
      sameIds(processing.source_ids, captured.source_ids, 'processing status changed the captured source identity');
      const readerProcessing = (await expected(`/api/captures/${captured.capture_id}`, 200, { token: grantB.token })).data;
      ensure(readerProcessing.status === 'processing' && readerProcessing.job.id === captured.job_id
        && readerProcessing.memory_ids.length === 0, 'independent reader HTTP status did not expose in-flight extraction');
      await control('release', {});
      const processed = await job(captured.job_id, 'complete');
      ensure(processed.result?.accepted === 3 && processed.result?.model === DEFAULT_MODEL_ID, 'actual worker extraction did not accept the configured three fixture memories');
      const completed = await captureStatus(b, captured.capture_id);
      ensure(completed.status === 'complete' && completed.job?.id === captured.job_id
        && completed.job.status === 'complete' && completed.job.accepted === 3 && completed.job.skipped === 0
        && completed.job.completed_at && completed.memory_ids.length === 3 && !completed.can_retry,
      'independent reader MCP status did not expose completed extraction and current memories');
      await indexed();
      const lexical = (await sql(`SELECT count(*) AS n FROM tk_memories WHERE owner_id=${literal(ownerId)}
        AND status='active' AND (search_vector @@ websearch_to_tsquery('english',${literal(semanticQuery)})
          OR position(lower(${literal(semanticQuery)}) in lower(statement))>0)`))[0];
      ensure(Number(lexical.n) === 0, 'semantic demonstration unexpectedly matched lexical retrieval');
      const first = await recall(b);
      ensure(first.coverage.retrieval === 'postgresql_hybrid' && first.coverage.semantic_search === 'enabled', 'hybrid retrieval was not enabled');
      sameStatements(first, [deadline, preference, inference], 'Client B did not receive every source-derived memory immediately');
      dl = first.memories.find((memory: any) => memory.statement === deadline);
      pref = first.memories.find((memory: any) => memory.statement === preference);
      for (const memory of [dl, pref]) {
        ensure(memory.origin === 'user_explicit' && memory.status === 'active', 'direct memory lost its evidence label');
        ensure(memory.extractor === DEFAULT_MODEL_ID && memory.effective_at === null, 'extraction metadata or effective date changed');
        ensure(memory.evidence.length === 1 && memory.evidence[0].quote === memory.statement
          && memory.evidence[0].author_role === 'user' && memory.evidence[0].origin === 'user_explicit'
          && memory.evidence[0].client_id === grantA.client.id, 'original evidence attribution was not preserved');
      }
      const inferred = first.memories.find((memory: any) => memory.statement === inference);
      ensure(inferred?.status === 'active' && inferred.origin === 'inferred' && inferred.authoritative === false
        && inferred.evidence[0].quote === preference && inferred.evidence[0].origin === 'user_explicit',
      'delivered inference lost its distinction from the original user statement');
      sameStatements(await recall(b, semanticQuery, { source: grantA.client.id }), [deadline, preference, inference],
        'originating-client filter lost delivered context');
      sameStatements(await recall(b, semanticQuery, { source: dl.evidence[0].source_id }), [deadline], 'source filter crossed independent events');
      sameStatements(await recall(b, semanticQuery, { source: grantB.client.id }), [], 'reader client became the source attribution');
    });
    await stage('immediate delivery and owner correction preserve original provenance through independent recall', async () => {
      const interpreted = (await recall(b, semanticQuery, { source: pref.evidence[0].source_id })).memories
        .find((memory: any) => memory.origin === 'inferred');
      ensure(interpreted?.statement === inference && interpreted.status === 'active' && interpreted.revision === 1
        && interpreted.extractor === DEFAULT_MODEL_ID, 'correction flow did not begin with the delivered worker inference');
      const before = (await expected('/api/memories/' + interpreted.id, 200)).data;
      const originalSource = before.sources.find((source: any) => source.id === pref.evidence[0].source_id);
      ensure(originalSource?.text === preference && originalSource.author_role === 'user'
        && originalSource.origin === 'user_explicit', 'delivered inference lost the original user-authored preference');
      for (const token of [grantA.token, grantB.token]) await expected(`/api/memories/${interpreted.id}`, 403, {
        method: 'PATCH', token, body: { statement: correctedInference, expected_revision: interpreted.revision },
      });
      const providerRequests = (await control('status')).chatRequests;
      corrected = await patch(interpreted, correctedInference);
      ensure((await control('status')).chatRequests === providerRequests, 'owner correction required model review');
      ensure(corrected.id === interpreted.id && corrected.statement === correctedInference && corrected.revision === 2
        && corrected.status === 'active' && corrected.origin === 'user_confirmed'
        && corrected.authoritative === true && corrected.extractor === null,
      'owner correction did not immediately create the authoritative current record');
      const detail = (await expected('/api/memories/' + corrected.id, 200)).data;
      const history = detail.revisions.find((revision: any) => revision.revision === 1);
      ensure(detail.revisions.length === 2 && history?.statement === inference && history.origin === 'inferred'
        && history.status === 'superseded' && history.extractor === DEFAULT_MODEL_ID,
      'correction rewrote the original inference or configured extractor history');
      const preservedSource = detail.sources.find((source: any) => source.id === originalSource.id);
      ensure(preservedSource?.text === preference && preservedSource.author_role === 'user'
        && preservedSource.origin === 'user_explicit' && preservedSource.extraction_blocked === true,
      'correction changed original source attribution or left it available for re-extraction');
      const oldEvidence = detail.evidence.filter((evidence: any) => evidence.revision === 1);
      ensure(oldEvidence.length === 1 && oldEvidence[0].source_id === originalSource.id
        && oldEvidence[0].quote === preference, 'correction lost the inference original quotation');
      const currentEvidence = detail.evidence.filter((evidence: any) => evidence.revision === corrected.revision);
      ensure(currentEvidence.length === 1 && currentEvidence[0].quote === correctedInference,
        'correction did not create distinct current-revision user evidence');
      correctionSourceId = currentEvidence[0].source_id;
      const correctionSource = detail.sources.find((source: any) => source.id === correctionSourceId);
      ensure(correctionSourceId !== originalSource.id && correctionSource?.text === correctedInference
        && correctionSource.author_role === 'user' && correctionSource.origin === 'user_confirmed'
        && correctionSource.client_id === 'profile' && correctionSource.capture_method === 'profile_correction'
        && correctionSource.extraction_blocked === true,
      'owner correction evidence was confused with the captured source');
      await indexed();
      const active = await recall(b, semanticQuery, { source: correctionSourceId });
      sameStatements(active, [correctedInference], 'Client B did not receive the owner correction');
      ensure(active.memories[0].id === corrected.id && active.memories[0].origin === 'user_confirmed'
        && active.memories[0].authoritative === true && active.memories[0].evidence[0].source_id === correctionSourceId
        && active.memories[0].evidence[0].capture_method === 'profile_correction',
      'fresh independent recall did not use the current correction evidence');
      sameStatements(await recall(b), [deadline, preference, correctedInference],
        'default independent recall did not include the current corrected wording');
      const stale = await expected(`/api/memories/${interpreted.id}`, 409, {
        method: 'PATCH', body: { statement: inference, expected_revision: interpreted.revision },
      });
      ensure(stale.data.error === 'revision_conflict', 'stale owner correction did not enforce the current revision');

      const proposal = 'I suggest weekly writing reminders for Atlas.';
      const reported = 'The writing agent reported completing the Atlas style check.';
      const proposed = await tool(a, 'context_capture', {
        idempotency_key: 'integration-agent-context', project_id: 'atlas',
        events: [
          { id: 'assistant-proposal', text: proposal, author_role: 'assistant', origin: 'assistant_proposed' },
          { id: 'agent-report', text: reported, author_role: 'assistant', origin: 'agent_reported' },
        ],
        explicit_memories: [
          { statement: proposal, kind: 'project_state', source_event_id: 'assistant-proposal', quote: proposal, origin: 'assistant_proposed' },
          { statement: reported, kind: 'project_state', source_event_id: 'agent-report', quote: reported, origin: 'agent_reported' },
        ],
      });
      await indexed();
      const delivered = await recall(b, semanticQuery, { source: grantA.client.id });
      for (const [statement, origin] of [[proposal, 'assistant_proposed'], [reported, 'agent_reported']]) {
        const memory = delivered.memories.find((memory: any) => memory.statement === statement);
        ensure(memory?.status === 'active' && memory.origin === origin && memory.authoritative === false
          && memory.evidence[0].author_role === 'assistant' && memory.evidence[0].origin === origin,
        'delivered agent context was mislabeled as a user assertion or acceptance');
        const original = (await expected('/api/memories/' + memory.id, 200)).data;
        ensure(original.revisions.length === 1 && original.sources.length === 1
          && original.sources[0].text === statement && original.sources[0].origin === origin,
        'delivery rewrote the original agent context or created endorsement history');
        for (const token of [grantA.token, grantB.token]) await expected(`/api/memories/${memory.id}`, 403, {
          method: 'DELETE', token, body: { expected_revision: memory.revision, preview_hash: 'not-owner-authorized' },
        });
        await remove(memory);
        await expected('/api/memories/' + memory.id, 404);
        await expected('/api/sources/' + memory.evidence[0].source_id, 404, { token: grantB.token });
        await toolDenied(b, 'context_get_source', { source_id: memory.evidence[0].source_id });
        sameStatements(await recall(b, semanticQuery, { source: memory.evidence[0].source_id }), [],
          'forgotten agent context remained delivered');
      }
      const exported = JSON.stringify((await expected('/api/export', 200)).data);
      ensure(!exported.includes(proposal) && !exported.includes(reported), 'export retained forgotten agent context');
      ensure(proposed.memory_ids.length === 2, 'agent context capture did not admit both independent memories');
    });
    await stage('authoritative profile correction and complete preference deletion', async () => {
      dl = await patch(dl, correctedDeadline);
      await remove(pref);
      await expected(`/api/sources/${pref.evidence[0].source_id}`, 404, { token: grantB.token });
      await toolDenied(b, 'context_get_source', { source_id: pref.evidence[0].source_id });
      await expected('/api/memories/' + corrected.id, 404);
      await expected('/api/sources/' + correctionSourceId, 404, { token: grantB.token });
      await toolDenied(b, 'context_get_source', { source_id: correctionSourceId });
      for (const client of [a, b]) sameStatements(await recall(client, 'deadline'), [correctedDeadline], 'fresh lexical recall retained an obsolete assertion');
      sameStatements(await recall(b, semanticQuery, { source: pref.evidence[0].source_id }), [], 'deletion retained the preference interpretation');
      await indexed();
      for (const client of [a, b]) {
        const fresh = await recall(client);
        sameStatements(fresh, [correctedDeadline], 'fresh hybrid recall retained deleted or obsolete context');
        const memory = fresh.memories[0];
        ensure(memory.revision === 2 && memory.authoritative === true && memory.origin === 'user_confirmed'
          && memory.evidence[0].origin === 'user_confirmed' && memory.evidence[0].quote === correctedDeadline && memory.evidence[0].capture_method === 'profile_correction',
        'correction was not authoritative current-revision profile evidence');
      }
      const exported = JSON.stringify((await expected('/api/export', 200)).data);
      ensure(!exported.includes(preference) && !exported.includes(inference) && !exported.includes(correctedInference),
        'export retained deleted original, inferred or corrected preference content');
      await expected(`/api/memories/${dl.id}`, 409, { method: 'PATCH', body: { statement: deadline, expected_revision: 1 } });
    });
    await stage('owner capture pause rejects new saves and replay while authorized recall and queued extraction continue', async () => {
      const settings = (await expected('/api/settings/capture', 200)).data;
      ensure(settings.paused === false && settings.version === 0, 'fresh owner capture settings were not enabled at version zero');
      for (const path of ['/api/settings/capture', '/api/settings/connection']) await expected(path, 403, { token: grantA.token });
      await expected('/api/settings/capture', 403, {
        method: 'PATCH', token: grantA.token, body: { paused: true, expected_version: settings.version },
      });
      const observed = await grant('Authenticated denied request probe', ['read', 'capture'], ['atlas']);
      ensure(observed.client.last_used_at === null, 'unused credential reported an authenticated request');
      await control('configure', { holdChat: true });
      const queuedText = 'The already queued capture deadline remains authorized.';
      const queuedInput = capture('pause-existing-queue', queuedText, 'atlas', false);
      const queued = await tool(a, 'context_capture', queuedInput);
      ensure(queued.status === 'pending' && queued.job_id, 'pause scenario did not first admit source-only extraction');
      const paused = (await expected('/api/settings/capture', 200, {
        method: 'PATCH', body: { paused: true, expected_version: settings.version },
      })).data;
      ensure(paused.paused === true && paused.version === settings.version + 1, 'owner pause did not advance its settings revision');
      const rejected = [
        { token: grantA.token, body: capture('paused-new-source', 'The paused source deadline must not be saved.', 'atlas', false) },
        { token: observed.token, body: capture('paused-new-explicit', 'The paused explicit deadline must not be saved.') },
        { body: capture('paused-profile-explicit', 'The paused profile deadline must not be saved.') },
        { token: grantA.token, body: queuedInput },
      ];
      for (const input of rejected) {
        const denied = await expected('/api/capture', 403, input);
        ensure(denied.data.error === 'capture_paused', 'paused HTTP capture did not report the canonical pause reason');
      }
      await toolDenied(a, 'context_capture', capture('paused-mcp-explicit', 'The paused MCP deadline must not be saved.'), /capture_paused/);
      await toolDenied(a, 'context_capture', queuedInput, /capture_paused/);
      const admitted = (await expected('/api/clients', 200)).data.clients.find((client: any) => client.id === observed.client.id);
      ensure(admitted?.created_at === observed.client.created_at && admitted.last_used_at,
        'valid credential on a denied operation did not count as an authenticated request');
      const absent = (await sql(`SELECT count(*) AS n FROM tk_sources WHERE owner_id=${literal(ownerId)}
        AND event_id IN ('paused-new-source','paused-new-explicit','paused-profile-explicit','paused-mcp-explicit')`))[0];
      ensure(Number(absent.n) === 0, 'paused capture persisted new source or explicit memory evidence');
      sameStatements(await recall(b), [correctedDeadline], 'pause blocked authorized independent MCP recall');
      sameStatements((await expected('/api/context/search?query=deadline', 200, { token: grantB.token })).data,
        [correctedDeadline], 'pause blocked authorized independent HTTP recall');
      await poll('already admitted extraction while paused', async () => (await control('status')).heldChat > 0, 20_000);
      const processing = await captureStatus(b, queued.capture_id);
      ensure(processing.status === 'processing' && processing.job?.id === queued.job_id,
        'pause cancelled an already admitted extraction job');
      await control('release', {});
      const processed = await job(queued.job_id, 'complete');
      ensure(processed.result.accepted === 1 && processed.result.model === DEFAULT_MODEL_ID,
        'paused owner prevented the configured worker from completing an existing job');
      await indexed();
      const queuedRecall = await recall(b, 'deadline', { source: queued.source_ids[0] });
      sameStatements(queuedRecall, [queuedText], 'independent reader could not recall context processed during pause');
      await remove(queuedRecall.memories[0]);
      const unchanged = (await expected('/api/settings/capture', 200, {
        method: 'PATCH', body: { paused: true, expected_version: paused.version },
      })).data;
      ensure(unchanged.paused === true && unchanged.version === paused.version,
        'memory activity or a current no-op changed the independent capture settings revision');
      const stale = await expected('/api/settings/capture', 409, {
        method: 'PATCH', body: { paused: false, expected_version: settings.version },
      });
      ensure(stale.data.error === 'capture_settings_conflict', 'stale capture settings action silently resumed saves');
      const resumed = (await expected('/api/settings/capture', 200, {
        method: 'PATCH', body: { paused: false, expected_version: paused.version },
      })).data;
      ensure(resumed.paused === false && resumed.version === paused.version + 1, 'owner resume did not restore capture admission');
      const resumedText = 'The resumed capture deadline is synthetic.';
      const saved = await tool(a, 'context_capture', capture('pause-resumed-explicit', resumedText));
      ensure(saved.status === 'complete' && saved.memory_ids.length === 1, 'new authorized capture failed after resume');
      const resumedRecall = await recall(b, 'deadline', { source: saved.source_ids[0] });
      sameStatements(resumedRecall, [resumedText], 'independent reader did not recall the post-resume capture');
      await remove(resumedRecall.memories[0]);
    });
    await stage('owner, project, source and client permission isolation', async () => {
      const hidden = await expected('/api/capture', 201, { body: capture('vault-deadline', 'The Vault deadline is 21 October 2026.', 'vault') });
      const saved = (await expected(`/api/captures/${hidden.data.capture_id}`, 200)).data;
      ensure(saved.status === 'saved' && saved.job === null && saved.memory_ids.length === 1 && !saved.can_retry,
        'explicit capture was not reported as saved without an extraction job');
      const otherId = randomUUID();
      await sql(`INSERT INTO tk_users(id,email,password_hash) SELECT ${literal(otherId)},'other@example.invalid',password_hash
        FROM tk_users WHERE id=${literal(ownerId)} RETURNING id`);
      const otherOwner = await login('other@example.invalid');
      const otherGrant = await grant('Other synthetic owner', ['read', 'capture'], ['atlas'], otherOwner.session);
      const other = await connect('integration-other-owner', otherGrant.token);
      const otherStatement = 'The other owner deadline is 22 October 2026.';
      await expected('/api/capture', 201, { token: otherGrant.token, body: capture('other-deadline', otherStatement) });
      await indexed();
      for (const query of ['deadline', semanticQuery]) {
        sameStatements(await recall(b, query), [correctedDeadline], 'scoped reader saw another project or owner');
        sameStatements(await recall(other, query), [otherStatement], 'other owner saw the first owner context');
      }
      await expected(`/api/sources/${hidden.data.source_ids[0]}`, 404, { token: grantB.token });
      await toolDenied(b, 'context_get_source', { source_id: hidden.data.source_ids[0] });
      await expected(`/api/captures/${hidden.data.capture_id}`, 404, { token: grantB.token });
      await toolDenied(b, 'context_capture_status', { capture_id: hidden.data.capture_id });
      await expected(`/api/captures/${hidden.data.capture_id}`, 404, { token: otherGrant.token });
      await toolDenied(other, 'context_capture_status', { capture_id: hidden.data.capture_id });
      const correctedSource = (await recall(b, 'deadline')).memories[0].evidence[0].source_id;
      await expected(`/api/sources/${correctedSource}`, 404, { token: otherGrant.token });
      await toolDenied(other, 'context_get_source', { source_id: correctedSource });
      await expected(`/api/memories/${dl.id}`, 404, { session: otherOwner.session });
      await expected('/api/context/search?query=deadline&project_id=vault', 403, { token: grantB.token });
      await toolDenied(b, 'context_search', { query: semanticQuery, project_id: 'vault' });
      await expected('/api/capture', 403, { token: grantB.token, body: capture('reader-denied', 'The denied deadline is synthetic.') });
      await toolDenied(b, 'context_capture', capture('reader-mcp-denied', 'The denied deadline is synthetic.'));
      await expected('/api/capture', 403, { token: grantA.token, body: capture('wrong-project', 'The denied deadline is synthetic.', 'vault') });
      await toolDenied(a, 'context_capture', capture('wrong-project-mcp', 'The denied deadline is synthetic.', 'vault'));
      await expected('/api/memories', 403, { token: grantA.token });
      const writerGrant = await grant('Capture only', ['capture'], ['atlas']);
      const writer = await connect('integration-capture-only', writerGrant.token);
      await expected('/api/context/search?query=deadline', 403, { token: writerGrant.token });
      await toolDenied(writer, 'context_search', { query: semanticQuery });
    });
    await stage('embedding HTTP failure, model and dimension validation with recovery', async () => {
      for (const embeddingMode of ['http-error', 'wrong-model', 'wrong-dimensions']) {
        await indexed();
        await control('configure', { embeddingMode });
        const fallback = await recall(b, 'deadline');
        sameStatements(fallback, [correctedDeadline], `${embeddingMode} blocked authorized lexical fallback`);
        ensure(fallback.coverage.retrieval === 'postgresql_full_text' && fallback.coverage.semantic_search === 'provider_unavailable',
          `${embeddingMode} did not report provider fallback`);
        const apiFallback = (await expected('/api/context/search?query=deadline', 200, { token: grantB.token })).data;
        sameStatements(apiFallback, [correctedDeadline], `${embeddingMode} broke HTTP lexical fallback`);
        const baseline = (await control('status')).completedEmbeddings;
        const pending = (await expected('/api/capture', 201, {
          body: capture(`embedding-${embeddingMode}`, `The ${embeddingMode} fixture deadline is synthetic.`, 'vault'),
        })).data;
        await poll(`worker rejected ${embeddingMode} embedding`, async () => (await control('status')).completedEmbeddings > baseline);
        const rejected = (await sql(`SELECT count(*) AS n FROM tk_embeddings WHERE memory_id=${literal(pending.memory_ids[0])}`))[0];
        ensure(Number(rejected.n) === 0, `${embeddingMode} response entered the configured vector space`);
        await poll(`worker persisted ${embeddingMode} cooldown`, async () => {
          const row = (await sql(`SELECT claim_token,next_attempt_at>now() AS deferred
            FROM tk_embedding_attempts WHERE memory_id=${literal(pending.memory_ids[0])}`))[0];
          return row?.claim_token === null && row.deferred === true;
        });
        await control('configure', { embeddingMode: 'ok' });
        // This is an isolated synthetic fixture database. Bring only its failed
        // record due rather than waiting for the production retry cooldown.
        await sql(`UPDATE tk_embedding_attempts SET next_attempt_at=clock_timestamp()-interval '1 second'
          WHERE memory_id=${literal(pending.memory_ids[0])} RETURNING memory_id`);
        await indexed();
        const recovered = await recall(b);
        ensure(recovered.coverage.retrieval === 'postgresql_hybrid', `${embeddingMode} prevented provider recovery`);
        sameStatements(recovered, [correctedDeadline], 'recovered hybrid retrieval crossed project scope');
      }
    });
    await stage('rejected oldest embedding batch defers durably while newer context and singleton retries progress', async () => {
      await indexed();
      const poisonText = `The synthetic rejected deadline contains ${FIXTURE_REJECTED_EMBEDDING_MARKER}.`;
      const healthyText = 'The healthy former-batch deadline is 4 November 2026.';
      const newerText = 'The newer valid deadline is 5 November 2026.';
      const correctedText = 'The corrected rejected deadline is 6 November 2026.';
      const forgottenText = `The synthetic forgotten deadline contains ${FIXTURE_REJECTED_EMBEDDING_MARKER}.`;
      const attempt = async (id: string) => (await sql(`SELECT revision,attempts,claim_token,lease_until,
        next_attempt_at>now() AS deferred,
        EXTRACT(EPOCH FROM (next_attempt_at-now())) AS remaining_seconds
        FROM tk_embedding_attempts WHERE memory_id=${literal(id)}`))[0];
      const vector = async (id: string, revision = 1) => (await sql(`SELECT memory_id FROM tk_embeddings
        WHERE memory_id=${literal(id)} AND revision=${revision} AND provider_model=${literal(FIXTURE_EMBEDDING_MODEL)}`)).length === 1;
      const due = (id: string) => sql(`UPDATE tk_embedding_attempts SET next_attempt_at=clock_timestamp()-interval '1 second'
        WHERE memory_id=${literal(id)} RETURNING memory_id`);
      const currentMemory = async (id: string) => (await expected('/api/memories/' + id, 200)).data.memory;
      const assertCooldown = (row: any, count: number, seconds: number, label: string) => {
        ensure(row && Number(row.revision) === 1 && Number(row.attempts) === count
          && row.claim_token === null && row.lease_until === null && row.deferred === true
          && Number(row.remaining_seconds) > seconds - 5 && Number(row.remaining_seconds) <= seconds,
        `${label} did not retain the bounded durable cooldown`);
      };
      try {
        await control('configure', { embeddingMode: 'reject-synthetic-marker', holdEmbeddings: true });
        const captured = await tool(a, 'context_capture', {
          idempotency_key: 'embedding-poison-batch', project_id: 'atlas',
          events: [
            { id: 'embedding-poison', text: poisonText, author_role: 'user', origin: 'user_explicit' },
            { id: 'embedding-healthy-peer', text: healthyText, author_role: 'user', origin: 'user_explicit' },
          ],
          explicit_memories: [
            { statement: poisonText, kind: 'fact', source_event_id: 'embedding-poison', quote: poisonText, origin: 'user_explicit' },
            { statement: healthyText, kind: 'fact', source_event_id: 'embedding-healthy-peer', quote: healthyText, origin: 'user_explicit' },
          ],
        });
        const [poisonId, healthyId] = captured.memory_ids;
        ensure(poisonId && healthyId && captured.memory_ids.length === 2, 'poison scenario did not atomically admit two memories');
        await poll('held rejected initial embedding batch', async () => (await control('status')).heldEmbeddings === 1, 20_000);
        ensure((await control('status')).lastEmbeddingInputCount === 2, 'initial rejection was not one fresh two-record batch');
        for (const id of [poisonId, healthyId]) {
          const claimed = await attempt(id);
          ensure(Number(claimed?.attempts) === 1 && claimed.claim_token && claimed.lease_until,
            'initial fresh batch did not claim each current revision');
        }
        await control('release', {});
        await poll('initial batch durable cooldowns', async () => {
          const rows = await Promise.all([attempt(poisonId), attempt(healthyId)]);
          return rows.every(row => row?.claim_token === null && row.deferred === true);
        });
        assertCooldown(await attempt(poisonId), 1, 30, 'rejected record');
        assertCooldown(await attempt(healthyId), 1, 30, 'healthy former-batch member');
        ensure(!await vector(poisonId) && !await vector(healthyId), 'rejected initial batch admitted vectors');

        const newer = await tool(a, 'context_capture', capture('embedding-newer-valid', newerText));
        await poll('newer context indexes around rejected oldest batch', () => vector(newer.memory_ids[0]));
        sameStatements(await recall(b, semanticQuery, { source: newer.source_ids[0] }), [newerText],
          'independent semantic recall could not reach newer context past the deferred batch');
        ensure(Number((await attempt(poisonId))?.attempts) === 1 && Number((await attempt(healthyId))?.attempts) === 1,
          'newer indexing immediately retried the deferred rejected batch');

        await control('configure', { holdEmbeddings: true });
        await due(healthyId);
        await poll('held singleton healthy retry', async () => (await control('status')).heldEmbeddings === 1, 20_000);
        ensure((await control('status')).lastEmbeddingInputCount === 1
          && Number((await attempt(healthyId))?.attempts) === 2
          && Number((await attempt(poisonId))?.attempts) === 1,
        'due former-batch member was not isolated from the still-deferred poison');
        await control('release', {});
        await poll('healthy singleton retry admission', async () => await vector(healthyId) && !await attempt(healthyId));
        sameStatements(await recall(b, semanticQuery, { source: captured.source_ids[1] }), [healthyText],
          'independent semantic recall lost the recovered former-batch member');

        await due(poisonId);
        await poll('second rejected singleton cooldown', async () => {
          const row = await attempt(poisonId);
          return Number(row?.attempts) === 2 && row.claim_token === null && row.deferred === true;
        });
        assertCooldown(await attempt(poisonId), 2, 60, 'second rejected singleton');
        ensure(!await vector(poisonId), 'rejected singleton entered the vector space');

        await control('configure', { holdEmbeddings: true });
        await due(poisonId);
        await poll('held rejected record before owner correction', async () => (await control('status')).heldEmbeddings === 1, 20_000);
        const corrected = await patch(await currentMemory(poisonId), correctedText);
        ensure(corrected.revision === 2 && !await attempt(poisonId), 'correction did not immediately clear the obsolete embedding attempt');
        await control('release', {});
        await poll('corrected revision indexes without old cooldown', async () => await vector(poisonId, 2) && !await attempt(poisonId));
        const correctedDetail = (await expected('/api/memories/' + poisonId, 200)).data;
        const correctedEvidence = correctedDetail.evidence.find((evidence: any) => Number(evidence.revision) === 2);
        ensure(correctedEvidence?.source_id, 'correction omitted current-revision evidence');
        sameStatements(await recall(b, semanticQuery, { source: correctedEvidence.source_id }), [correctedText],
          'independent semantic recall did not admit the corrected poison revision');

        await control('configure', { embeddingMode: 'ok', holdEmbeddings: true });
        const forgotten = await tool(a, 'context_capture', capture('embedding-poison-forget', forgottenText));
        const forgottenId = forgotten.memory_ids[0];
        await poll('held successful embedding before forgetting', async () => (await control('status')).heldEmbeddings === 1, 20_000);
        ensure((await attempt(forgottenId))?.claim_token, 'forgetting scenario lacked a durable in-flight attempt');
        await remove(await currentMemory(forgottenId));
        ensure(!await attempt(forgottenId), 'forgetting retained the deleted embedding attempt');
        await control('release', {});
        // The single worker indexes this later capture only after the held
        // reply settles, fencing its stale admission before the deletion check.
        const fence = await tool(a, 'context_capture', capture('embedding-poison-forget-fence', 'The synthetic embedding completion deadline fence.'));
        await poll('embedding forgetting completion fence', () => vector(fence.memory_ids[0]));
        const remnants = (await sql(`SELECT
          (SELECT count(*) FROM tk_memories WHERE id=${literal(forgottenId)}) AS memories,
          (SELECT count(*) FROM tk_sources WHERE id=${literal(forgotten.source_ids[0])}) AS sources,
          (SELECT count(*) FROM tk_embeddings WHERE memory_id=${literal(forgottenId)}) AS embeddings,
          (SELECT count(*) FROM tk_embedding_attempts WHERE memory_id=${literal(forgottenId)}) AS attempts`))[0];
        ensure(Object.values(remnants).every(count => Number(count) === 0), 'in-flight embedding restored forgotten content or retry state');
        for (const id of [poisonId, healthyId, newer.memory_ids[0], fence.memory_ids[0]]) await remove(await currentMemory(id));
        await indexed();
      } finally {
        await control('configure', { embeddingMode: 'ok', holdEmbeddings: false }, true).catch(() => undefined);
        await control('release', {}, true).catch(() => undefined);
      }
    });
    await stage('live capture failure, owner retry and independent recall preserve source and job identity', async () => {
      for (const chatMode of ['http-error', 'wrong-model']) {
        await control('configure', { chatMode });
        const text = `The ${chatMode} extraction deadline is synthetic.`;
        const input = capture(`chat-${chatMode}`, text, 'atlas', false);
        const captured = await tool(a, 'context_capture', input);
        ensure(captured.status === 'pending' && captured.job_id && captured.memory_ids.length === 0,
          'failure scenario did not queue a source-only capture');
        const failed = await job(captured.job_id, 'failed');
        ensure(failed.error_code === 'provider_or_validation_failed' && Number(failed.attempts) === 1 && failed.result === null,
          'failed extraction did not retain sanitized durable failure state');
        const ownerFailure = (await expected(`/api/captures/${captured.capture_id}`, 200)).data;
        ensure(ownerFailure.status === 'failed' && ownerFailure.job?.id === captured.job_id
          && ownerFailure.job.status === 'failed' && ownerFailure.job.attempts === 1
          && ownerFailure.job.error_code === 'provider_or_validation_failed'
          && ownerFailure.job.accepted === null && ownerFailure.job.skipped === null
          && ownerFailure.job.completed_at && ownerFailure.memory_ids.length === 0 && ownerFailure.can_retry,
        'owner HTTP status did not expose the failed retryable job');
        sameIds(ownerFailure.source_ids, captured.source_ids, 'failed extraction lost source evidence');
        const readerFailure = await captureStatus(b, captured.capture_id);
        ensure(readerFailure.status === 'failed' && readerFailure.job?.id === captured.job_id
          && readerFailure.job.error_code === 'provider_or_validation_failed' && !readerFailure.can_retry,
        'independent reader MCP status did not expose failure with owner-only recovery');
        const count = (await sql(`SELECT count(*) AS n FROM tk_memories WHERE statement=${literal(text)}`))[0];
        ensure(Number(count.n) === 0, `${chatMode} extraction admitted provider output`);
        const cachedFailure = await tool(a, 'context_capture', input);
        ensure(cachedFailure.capture_id === captured.capture_id && cachedFailure.job_id === captured.job_id
          && cachedFailure.status === 'pending' && cachedFailure.memory_ids.length === 0,
        'idempotent capture receipt changed instead of using fresh job status');
        await expected(`/api/captures/${captured.capture_id}/retry`, 403, {
          token: grantB.token, body: { expected_attempts: ownerFailure.job.attempts },
        });
        await expected(`/api/captures/${captured.capture_id}/retry`, 403, {
          token: grantA.token, body: { expected_attempts: ownerFailure.job.attempts },
        });
        await expected(`/api/captures/${captured.capture_id}/retry`, 409, {
          body: { expected_attempts: 0 },
        });
        await control('configure', { chatMode: 'ok', holdChat: true });
        const retried = (await expected(`/api/captures/${captured.capture_id}/retry`, 200, {
          body: { expected_attempts: ownerFailure.job.attempts },
        })).data;
        ensure(retried.capture_id === captured.capture_id && retried.job?.id === captured.job_id
          && ['pending', 'processing'].includes(retried.status) && !retried.can_retry,
        'owner retry did not requeue the existing capture job');
        sameIds(retried.source_ids, captured.source_ids, 'owner retry changed the original source identity');
        await poll('held retry extraction request', async () => (await control('status')).heldChat > 0, 20_000);
        const retryProcessing = await captureStatus(a, captured.capture_id);
        ensure(retryProcessing.status === 'processing' && retryProcessing.job?.id === captured.job_id
          && retryProcessing.job.attempts === 2 && retryProcessing.job.error_code === null
          && retryProcessing.job.completed_at === null && retryProcessing.memory_ids.length === 0,
        'retry progress did not expose a clean second attempt for the same job');
        await expected(`/api/captures/${captured.capture_id}/retry`, 409, {
          body: { expected_attempts: ownerFailure.job.attempts },
        });
        await control('release', {});
        const successful = await job(captured.job_id, 'complete');
        ensure(successful.result.accepted === 1 && successful.result.model === DEFAULT_MODEL_ID, 'worker did not recover with the configured memory model');
        const recovered = await captureStatus(b, captured.capture_id);
        ensure(recovered.status === 'complete' && recovered.job?.id === captured.job_id && recovered.job.attempts === 2
          && recovered.job.accepted === 1 && recovered.job.skipped === 0 && recovered.job.error_code === null
          && recovered.memory_ids.length === 1 && !recovered.can_retry,
        'fresh MCP status did not expose the one completed recovered memory');
        sameIds(recovered.source_ids, captured.source_ids, 'completed retry changed the source identity');
        await indexed();
        const recalled = await recall(b, 'deadline', { source: captured.source_ids[0] });
        sameStatements(recalled, [text], 'Client B did not recall the original failed source after owner recovery');
        sameIds(recalled.memories.map((memory: any) => memory.id), recovered.memory_ids,
          'capture status and independent recall disagree on current recovered memories');
        const current = (await expected('/api/memories/' + recovered.memory_ids[0], 200)).data.memory;
        await remove(current);
        const forgotten = (await expected(`/api/captures/${captured.capture_id}`, 200)).data;
        ensure(forgotten.status === 'cancelled' && forgotten.job === null && forgotten.source_ids.length === 0
          && forgotten.memory_ids.length === 0 && !forgotten.can_retry,
        'forgotten recovered capture retained live content or a retry action');
      }
    });
    await stage('correction and deletion during in-flight embedding processing', async () => {
      await indexed();
      await control('configure', { holdEmbeddings: true });
      const correctedText = 'The embedding race deadline is 29 October 2026.';
      const captured = await tool(a, 'context_capture', {
        idempotency_key: 'embedding-race', project_id: 'atlas',
        events: [
          { id: 'embedding-race-correct', text: 'The embedding race deadline is 28 October 2026.', author_role: 'user', origin: 'user_explicit' },
          { id: 'embedding-race-delete', text: 'The embedding race preference is disposable.', author_role: 'user', origin: 'user_explicit' },
        ],
        explicit_memories: [
          { statement: 'The embedding race deadline is 28 October 2026.', kind: 'fact', source_event_id: 'embedding-race-correct', quote: 'The embedding race deadline is 28 October 2026.', origin: 'user_explicit' },
          { statement: 'The embedding race preference is disposable.', kind: 'preference', source_event_id: 'embedding-race-delete', quote: 'The embedding race preference is disposable.', origin: 'user_explicit' },
        ],
      });
      await poll('held worker embedding request', async () => (await control('status')).heldEmbeddings > 0, 20_000);
      const detail = (await expected('/api/memories/' + captured.memory_ids[0], 200)).data.memory;
      const deleted = (await expected('/api/memories/' + captured.memory_ids[1], 200)).data.memory;
      const corrected = await patch(detail, correctedText);
      await remove(deleted);
      await control('release', {});
      await indexed();
      const rows = await sql(`SELECT memory_id,revision FROM tk_embeddings WHERE memory_id IN
        (${literal(detail.id)},${literal(deleted.id)})`);
      ensure(rows.length === 1 && rows[0].memory_id === corrected.id && Number(rows[0].revision) === 2,
        'in-flight embedding restored an old revision or deleted memory');
      await expected('/api/memories/' + deleted.id, 404);
      await remove(corrected);
    });
    await stage('correction and deletion during in-flight source extraction', async () => {
      const original = 'The extraction race deadline is 30 October 2026.';
      const corrected = 'The extraction race deadline is 31 October 2026.';
      const seeded = await tool(a, 'context_capture', capture('extraction-race-correct', original));
      const seedMemory = (await expected('/api/memories/' + seeded.memory_ids[0], 200)).data.memory;
      await indexed();
      await control('configure', { holdChat: true });
      const input = capture('extraction-race-correct', original, 'atlas', false);
      input.idempotency_key = 'extraction-race-correct-reprocess';
      const pending = await tool(a, 'context_capture', input);
      await poll('held correction extraction request', async () => (await control('status')).heldChat > 0, 20_000);
      const changed = await patch(seedMemory, corrected);
      await control('release', {});
      const cancelled = await job(pending.job_id, 'cancelled');
      ensure(cancelled.result === null, 'cancelled stale-source extraction admitted a result after correction');
      // Cancellation is visible before the provider reply is admitted. A later
      // job on this worker proves the held attempt settled before stale-write
      // invariants are inspected.
      const correctionFence = await tool(a, 'context_capture', capture('extraction-correction-fence', 'Synthetic correction completion fence.', 'atlas', false));
      await job(correctionFence.job_id, 'complete');
      const correctionFenceMemory = (await expected('/api/memories?source=' + encodeURIComponent(correctionFence.source_ids[0]), 200)).data.memories[0];
      await remove(correctionFenceMemory);
      const cancelledCapture = await captureStatus(a, pending.capture_id);
      ensure(cancelledCapture.status === 'cancelled' && cancelledCapture.job?.id === pending.job_id
        && cancelledCapture.job.status === 'cancelled' && !cancelledCapture.can_retry,
      'fresh capture status did not report correction-blocked extraction as cancelled');
      const rows = await sql(`SELECT id,statement,revision FROM tk_memories WHERE owner_id=${literal(ownerId)}
        AND statement IN (${literal(original)},${literal(corrected)})`);
      ensure(rows.length === 1 && rows[0].statement === corrected && Number(rows[0].revision) === 2, 'in-flight extraction restored the obsolete deadline');
      await remove(changed);

      const forgotten = 'The extraction race preference must be forgotten.';
      const deletedSeed = await tool(a, 'context_capture', capture('extraction-race-delete', forgotten));
      const toDelete = (await expected('/api/memories/' + deletedSeed.memory_ids[0], 200)).data.memory;
      await indexed();
      await control('configure', { holdChat: true });
      const deletionInput = capture('extraction-race-delete', forgotten, 'atlas', false);
      deletionInput.idempotency_key = 'extraction-race-delete-reprocess';
      const deletedJob = await tool(a, 'context_capture', deletionInput);
      await poll('held deletion extraction request', async () => (await control('status')).heldChat > 0, 20_000);
      const requests = await control('status');
      await remove(toDelete);
      await control('release', {});
      await poll('in-flight deleted extraction response completed', async () => (await control('status')).completedChat > requests.completedChat);
      // A new job, processed by the same worker after the held response, fences
      // the stale extraction commit before checking the deletion invariants.
      const fence = await tool(a, 'context_capture', capture('extraction-race-fence', 'Synthetic extraction completion fence.', 'atlas', false));
      await job(fence.job_id, 'complete');
      const fenceMemory = (await expected('/api/memories?source=' + encodeURIComponent(fence.source_ids[0]), 200)).data.memories[0];
      await remove(fenceMemory);
      const remnants = (await sql(`SELECT (SELECT count(*) FROM tk_jobs WHERE id=${literal(deletedJob.job_id)}) AS jobs,
        (SELECT count(*) FROM tk_memories WHERE id=${literal(toDelete.id)} OR statement=${literal(forgotten)}) AS memories,
        (SELECT count(*) FROM tk_sources WHERE id=${literal(deletedSeed.source_ids[0])}) AS sources,
        (SELECT count(*) FROM tk_embeddings WHERE memory_id=${literal(toDelete.id)}) AS embeddings`))[0];
      ensure(Object.values(remnants).every(count => Number(count) === 0), 'in-flight extraction restored deleted jobs, sources, memories or vectors');
    });
    await stage('fresh final context, keyless fixture identity and client revocation', async () => {
      await indexed();
      for (const client of [a, b]) sameStatements(await recall(client), [correctedDeadline], 'final fresh recall retained race or deleted context');
      const stats = await control('status');
      ensure(stats.chatRequests > 0 && stats.embeddingRequests > 0 && stats.authorizationSeen === false,
        'keyless fixture adapter was not exercised or unexpectedly received credentials');
      ensure(JSON.stringify(stats.models) === JSON.stringify([DEFAULT_MODEL_ID, FIXTURE_EMBEDDING_MODEL].sort())
        && JSON.stringify(stats.dimensions) === '[3]', 'adapter silently selected another model or embedding dimension');
      const lastReaderRequest = (await expected('/api/clients', 200)).data.clients.find((client: any) => client.id === grantB.client.id).last_used_at;
      ensure(lastReaderRequest, 'independent reader had no observed authenticated request before revocation');
      await expected(`/api/clients/${grantB.client.id}`, 200, { method: 'DELETE' });
      const before = (await control('status')).embeddingRequests;
      await expected('/api/context/search?query=deadline', 401, { token: grantB.token });
      await toolDenied(b, 'context_search', { query: semanticQuery });
      ensure((await control('status')).embeddingRequests === before, 'revoked client reached the embedding provider');
      const revoked = (await expected('/api/clients', 200)).data.clients.find((client: any) => client.id === grantB.client.id);
      ensure(revoked.revoked_at && revoked.last_used_at === lastReaderRequest,
        'rejected revoked credential updated the last authenticated request timestamp');
    });
    return passed;
  } finally {
    options.signal?.removeEventListener('abort', abortClients);
    // Always clear fixture fault modes and release holds before teardown,
    // including a failure partway through a synthetic rejection stage.
    await control('configure', { chatMode: 'ok', embeddingMode: 'ok', holdChat: false, holdEmbeddings: false }, true).catch(() => undefined);
    await control('release', {}, true).catch(() => undefined);
    for (const client of clients) await client.close().catch(() => undefined);
  }
}
