import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrap } from '../apps/api/src/auth.ts';
import { createApp } from '../apps/api/src/app.ts';
import { createTestDatabase } from '../tests/helpers.ts';
import { OpenAICompatibleProvider } from '../packages/providers/src/index.ts';
import { installDirectProviderObserver, summarizeProviderObservations } from './direct-provider-observer.mjs';
import { assertLearnedArchiveHistory, assertLearnedDeadlineHistory, assertLearnedDeletionPreview, assertLearnedExtraction,
  directLearnedCase, learnedDetail, learnedRecallRecord } from './integration/learned-assertions.ts';
import { snapshotLearnedExtraction, verifyLearnedExtractionEvidence } from './integration/learned-extraction-evidence.ts';
import { reserveEvidence, verifyLearnedSnapshot } from './integration/learned-support.ts';
import { OpenCodeProviderGuard } from './opencode-provider-guard.mjs';
import { assertCaptureEvidence, assertRecallEvidence, correctedDeadline, observeMcpCall, opencodeProject, type HostPhase,
  type McpEvidence, type McpPhase } from './opencode-evidence.ts';
import { assertHostResult, opencodeEndpoint, opencodeModel, runOpenCodeHost, type HostResult } from './opencode-host.ts';

type Options = { root: string; directory: string; source: { commit: string; tree: string; files: Record<string, string> };
  output: string; binary: { path: string; sha256: string; version: string }; host_dependencies: unknown; signal: AbortSignal };
const capturePrompt = `Please save two user-approved statements to Threadkeeper, preserving the exact separate source events below. Use project_id ${opencodeProject}, subject self and idempotency_key installed-opencode-capture. Send sources only: omit explicit_memories so the canonical worker extracts them. Do not paraphrase event text or alter provenance. Report that extraction is pending after the tool succeeds.\n${JSON.stringify(directLearnedCase.events)}`;
const recallPrompt = `Please recall all current active context for project ${opencodeProject} from Threadkeeper. Use an empty query and limit 10 so the complete current project state is returned. Do not infer context from this instruction. Call the configured tool, then briefly acknowledge the retrieved context.`;

/** Actual published hosts choose MCP calls; canonical application code owns storage and edits. */
export async function runOpenCodeLifecycle(options: Options) {
  options.signal.throwIfAborted();
  assert(process.connected, 'Use the source-bound supervisor for installed-host execution');
  assert.equal(options.binary.version, '1.18.34');
  await verifyLearnedSnapshot(options.root, options.source);
  assert(process.env.NEBIUS_API_KEY, 'NEBIUS_API_KEY must be configured without printing it');
  const key = process.env.NEBIUS_API_KEY;
  const secrets = [key], mcp: McpEvidence[] = [], mcpFailures: string[] = [], hosts: HostResult[] = [];
  const checks: string[] = [];
  let stage = 'reserve-output', failed = false, active: McpPhase | undefined;
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined, server: Server | undefined;
  let observer: ReturnType<typeof installDirectProviderObserver> | undefined;
  const hostDirectory = resolve(options.directory, 'hosts');
  const output = await reserveEvidence(options.output);
  try {
    if (process.send) await new Promise<void>((done, reject) => process.send!({ event: 'evidence_reserved', ...output.identity },
      (error: Error | null) => error ? reject(error) : done()));
  } catch {
    await output.close(); await output.discard(); throw new Error('Evidence reservation acknowledgement failed');
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    options.signal.throwIfAborted();
    const incoming = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return originalFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([options.signal, ...(incoming ? [incoming] : [])]) });
  };
  let flow: Record<string, unknown> = {}, appSummary: ReturnType<typeof summarizeProviderObservations> | undefined;
  try {
    await mkdir(hostDirectory, { mode: 0o700 });
    stage = 'create-private-application';
    database = await createTestDatabase();
    assert.equal(database.backend, 'pglite');
    const password = randomBytes(24).toString('hex'), email = 'opencode-host@example.invalid'; secrets.push(password);
    await bootstrap(database.db, email, password);
    server = createServer();
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
    const address = server.address(); assert(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const { app, store } = createApp(database.db, { origin: base });
    const observed = express();
    observed.use(express.json({ limit: '128kb' }));
    observed.use((req, res, next) => {
      try {
        if (req.path === '/mcp' && req.body?.method === 'tools/call') {
          assert(active, 'MCP tool request outside a host phase');
          observeMcpCall(req, res, active, mcp, mcpFailures);
        }
        next();
      } catch { mcpFailures.push('mcp_request_observation_failed'); res.status(400).json({ error: 'bounded_host_request_rejected' }); }
    });
    observed.use(app); server.on('request', observed);
    let cookie = '';
    const http = async (path: string, body?: unknown, method?: string) => {
      const response = await fetch(base + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Origin: base, 'Content-Type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
      });
      assert(response.ok, 'Owner HTTP operation failed');
      return { response, data: await response.json() as any };
    };
    const login = await http('/api/auth/login', { email, password });
    cookie = login.response.headers.get('set-cookie')?.split(';')[0] ?? ''; assert(cookie); secrets.push(cookie);
    const a = (await http('/api/clients', { name: 'Installed OpenCode A', permissions: ['read', 'capture'], projects: [opencodeProject] })).data;
    const b = (await http('/api/clients', { name: 'Installed OpenCode B', permissions: ['read'], projects: [opencodeProject] })).data;
    secrets.push(a.token, b.token); assert.notEqual(a.client.id, b.client.id);
    const phase = async (id: HostPhase, credential: typeof a, prompt: string) => {
      options.signal.throwIfAborted(); stage = id;
      active = { id, client_id: credential.client.id, token: credential.token, started: 0, rpc_ids: new Set() };
      const outcome = await runOpenCodeHost({ root: options.root, directory: hostDirectory, binary: options.binary.path,
        key, phase: id, endpoint: base + '/mcp', token: credential.token, prompt, signal: options.signal });
      hosts.push(outcome);
      await new Promise<void>(done => setImmediate(done));
      assertHostResult(outcome);
      const records = mcp.filter(record => record.phase === id);
      assert.equal(records.length, active.started, 'Unpaired MCP request/response');
      assert.equal(outcome.tool_events.length, records.length, 'Host and application tool invocation counts differ');
      assert.equal(mcpFailures.length, 0, 'MCP observation failed');
      active = undefined;
      return records;
    };
    const captured = assertCaptureEvidence(await phase('capture-a', a, capturePrompt));
    assert.equal((await database.db.query('SELECT id FROM tk_memories')).rows.length, 0, 'Source-only capture fabricated learned records');
    assert.equal((await database.db.query('SELECT id FROM tk_jobs')).rows.length, 1, 'Expected one canonical extraction job');
    checks.push('Published OpenCode A chose a source-only MCP capture with two exact independent source events.');

    stage = 'direct-canonical-extraction';
    observer = installDirectProviderObserver({ baseUrl: opencodeEndpoint, models: [opencodeModel],
      limits: { 'chat/completions': 2, embeddings: 0, models: 0 }, extractionFingerprints: true });
    const provider = new OpenAICompatibleProvider({ baseUrl: opencodeEndpoint, apiKey: key, modelId: opencodeModel,
      timeoutMs: 45_000, maxOutputTokens: 4096, reasoningEffort: 'none', structuredOutput: false, jsonObject: true, maxEvents: 2, maxSourceCharacters: 5000 });
    assert(await store.processJob(provider), 'Worker did not claim the captured job');
    const status = (await http(`/api/captures/${captured.capture_id}`)).data;
    assert.equal(status.status, 'complete', 'Canonical extraction failed');
    const canonical = (await http(`/api/memories?project_id=${opencodeProject}`)).data.memories;
    const sources = await Promise.all(captured.source_ids.map(async (id: string) => (await http(`/api/sources/${id}`)).data));
    const extracted = assertLearnedExtraction(canonical, sources, opencodeProject, a.client.id);
    const extraction = snapshotLearnedExtraction(canonical, sources, { project_id: opencodeProject, subject: 'self' });
    verifyLearnedExtractionEvidence(extraction, observer.records.map(record => ({ ...record, service: 'worker' as const })));
    appSummary = summarizeProviderObservations(observer.records);
    assert(observer.records.every(record => !record.usage_invalid && OpenCodeProviderGuard.usageIsComplete(record.usage)), 'Application token usage is inconsistent');
    assert(appSummary.usage_complete && appSummary.inference_request_count >= 1 && appSummary.inference_request_count <= 2, 'Application usage accounting incomplete');
    assert.equal(observer.errors.length, 0, 'Application observation failed');
    checks.push('Actual canonical worker extracted both records through direct Nemotron; persisted content matches its final parsed response.');
    flow = { capture: captured, extraction, original_memories: canonical, original_sources: sources };
    assertRecallEvidence(await phase('recall-b', b, recallPrompt), 'recall-b', canonical);
    checks.push('Independent OpenCode B chose MCP recall and received both canonical learned records.');

    stage = 'owner-correction-and-forgetting';
    const { deadline, preference } = extracted;
    const original = learnedDetail((await http(`/api/memories/${deadline.id}`)).data);
    const changed = (await http(`/api/memories/${deadline.id}`, { statement: correctedDeadline, expected_revision: deadline.revision }, 'PATCH')).data.memory;
    assert.equal(changed.statement, correctedDeadline);
    const corrected = assertLearnedDeadlineHistory((await http(`/api/memories/${deadline.id}`)).data, original, changed);
    const preferenceSource = sources.find(source => source.id === preference.evidence[0].source_id)!;
    const preview = assertLearnedDeletionPreview((await http(`/api/memories/${preference.id}/deletion-preview`)).data,
      preference, preferenceSource, deadline.evidence[0].source_id, captured.job_id);
    const removed = (await http(`/api/memories/${preference.id}`, { expected_revision: preference.revision, preview_hash: preview.preview_hash }, 'DELETE')).data;
    assert.deepEqual(removed.deleted_memory_ids, [preference.id]);
    assert.deepEqual(removed.deleted_source_ids, [preferenceSource.id]);
    assert.deepEqual(removed.deleted_job_ids, [captured.job_id]);
    const current = (await http(`/api/memories?project_id=${opencodeProject}`)).data.memories;
    assert.deepEqual(current.map((memory: any) => memory.id), [deadline.id]);
    const expected = [learnedRecallRecord(corrected)];
    assertLearnedArchiveHistory((await http('/api/export')).data, corrected, { memory: preference, source: preferenceSource });
    assert.equal((await database.db.query('SELECT id FROM tk_jobs')).rows.length, 0, 'Forgotten extraction work remains');
    for (const [id, credential] of [['fresh-a', a], ['fresh-b', b]] as const) {
      assertRecallEvidence(await phase(id, credential, recallPrompt), id, expected);
    }
    assert.equal(new Set(hosts.flatMap(host => host.session_ids)).size, 4, 'Host phases reused a session');
    assert.equal(observer.records.length, appSummary.observed_attempt_count, 'Owner/recall flow unexpectedly called a provider');
    flow = { ...flow, correction: corrected, forgetting: { preview, removed }, final_memories: current,
      client_ids: [a.client.id, b.client.id], fresh_sessions: hosts.map(host => ({ phase: host.phase, session_id: host.session_ids[0] })) };
    checks.push('Owner HTTP correction and preview-confirmed forgetting are reflected by fresh independent A/B host sessions.');
    stage = 'complete';
  } catch { failed = true; }
  finally {
    active = undefined;
    observer?.restore();
    globalThis.fetch = originalFetch;
    const cleanup = await Promise.allSettled([
      server ? new Promise<void>((done, reject) => { server!.close(error => error ? reject(error) : done()); server!.closeAllConnections(); }) : Promise.resolve(),
      database?.close(), rm(hostDirectory, { recursive: true, force: true }),
    ]);
    if (cleanup.some(result => result.status === 'rejected')) { failed = true; stage = 'cleanup-failed'; }
  }
  const evidence = { schema_version: 'threadkeeper.opencode-learned-host.v1', recorded_at: new Date().toISOString(), result: failed ? 'FAIL' : 'PASS', stage,
    source: options.source, host_dependencies: options.host_dependencies, host: { name: 'OpenCode', version: options.binary.version, sha256: options.binary.sha256 },
    database: 'fresh in-memory PGlite; native acceptance is a separate checkpoint', endpoint: opencodeEndpoint, model: opencodeModel, reasoning_effort: 'none',
    limits: { host_phases: 4, host_requests_per_phase: 4, application_requests: 2, maximum_total_chat_requests: 18, embeddings: 0,
      host_output_tokens: 1024, application_output_tokens: 4096, host_wall_timeout_seconds: 120 },
    checks, hosts, mcp, mcp_observation_failures: mcpFailures, application: { observations: observer?.records ?? [], summary: appSummary ?? summarizeProviderObservations(observer?.records ?? []) }, flow,
    cleanup: { hosts_closed: hosts.every(host => host.closed && host.group_terminated), private_host_state_removed: stage !== 'cleanup-failed', api_and_database_closed: stage !== 'cleanup-failed' },
    limitations: ['Finite synthetic installed-host tool selection and canonical retrieval; does not score host final-answer wording.',
      'No embeddings, GPU parity, other host-family parity, production deployment or broad extraction accuracy claim.',
      'Per-process original-fetch budget is instrumentation, not an operating-system network firewall.'] };
  try {
    const json = JSON.stringify(evidence, null, 2) + '\n';
    assert(secrets.every(secret => !json.includes(secret)), 'Evidence contains a credential');
    if (failed) {
      process.stdout.write(JSON.stringify({ event: 'opencode_lifecycle_evidence', ...evidence }) + '\n');
      throw new Error('Installed OpenCode lifecycle failed; sanitized failed observations were emitted');
    }
    options.signal.throwIfAborted();
    await verifyLearnedSnapshot(options.root, options.source);
    await output.publish(json, options.signal);
    options.signal.throwIfAborted();
    process.stdout.write(JSON.stringify({ event: 'opencode_lifecycle_complete', result: 'PASS', source: options.source.commit,
      host_requests: hosts.reduce((sum, host) => sum + host.provider.filter(record => record.event === 'opencode_provider_request').length, 0),
      application_requests: appSummary!.direct_request_count }) + '\n');
  } finally { await output.close(); }
}
