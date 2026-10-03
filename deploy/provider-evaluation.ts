import assert from 'node:assert/strict';
import { installDirectProviderObserver, providerObservationConfigFromEnv, summarizeProviderObservations } from './direct-provider-observer.mjs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/api/src/app.ts';
import { bootstrap } from '../apps/api/src/auth.ts';
import { createTestDatabase } from '../tests/helpers.ts';
import { OpenAICompatibleProvider, providerConfigFromEnv, DEFAULT_MODEL_ID } from '../packages/providers/src/index.ts';
import { evaluationCorpus, type EvaluationCase } from './provider-evaluation-corpus.ts';
import { evaluateMemoryRubric } from './provider-evaluation-rubric.ts';
import { extractionHoldout, extractionHoldoutManifest, extractionHoldoutSha256, assertHoldoutConfig } from './provider-extraction-holdout.ts';
import { extractionHoldoutV2, extractionHoldoutV2Manifest, extractionHoldoutV2Sha256 } from './provider-extraction-holdout-v2.ts';
import { taxonomyProbe, taxonomyProbeManifest, taxonomyProbeSha256, type TaxonomyCase } from './provider-taxonomy-probe.ts';
import { evaluateTaxonomyOutcome } from './provider-taxonomy-checks.ts';
import { assertHoldoutRecords, evaluateHoldoutOutcome, holdoutRequestLimits, assessHoldoutObservations } from './provider-holdout-checks.ts';

type RecordedAttempt = { request: any; response?: any; error?: { code: string; status?: number }; elapsed_ms?: number };
type Recording = { schema_version: string; cases: Array<{ id: string; attempts: RecordedAttempt[] }> };
const legacyHoldout = process.argv.includes('--holdout-v1');
const holdout = process.argv.includes('--holdout') || legacyHoldout;
const taxonomy = process.argv.includes('--taxonomy');
const boundedProbe = holdout || taxonomy;
const manifest = taxonomy ? taxonomyProbeManifest : legacyHoldout ? extractionHoldoutManifest : extractionHoldoutV2Manifest;
const manifestSha256 = taxonomy ? taxonomyProbeSha256 : legacyHoldout ? extractionHoldoutSha256 : extractionHoldoutV2Sha256;
const metadataKey = taxonomy ? 'taxonomy_probe' : 'holdout';
const lifecycleReason = taxonomy ? 'assertion_kind_probe_only' : 'extraction_holdout_only';
const args = process.argv.slice(2).filter(value => !['--holdout', '--holdout-v1', '--taxonomy'].includes(value));
const mode = args[0] ?? '--live';
const corpus = taxonomy ? taxonomyProbe : holdout ? legacyHoldout ? extractionHoldout : extractionHoldoutV2 : evaluationCorpus;
let recording: Recording | undefined;
const output: Array<Record<string, any>> = [];
const requests: Recording['cases'] = [];
let currentCase: EvaluationCase;
let attempts: RecordedAttempt[] = [];
let replayOffset = 0;
let mismatch = false;
let currentProgress: Record<string, any> | undefined;
let deferredReport: Record<string, any> | undefined;
let sourceCommit: string | undefined;
const probeMetadata = () => boundedProbe ? {
  [metadataKey]: { manifest, manifest_sha256: manifestSha256, source_commit: sourceCommit ?? null },
  manual_review: { status: 'required', instruction: manifest.manual_review },
} : {};
function report(value: Record<string, any>) {
  if (boundedProbe) deferredReport = value;
  else console.info(JSON.stringify(value, null, 2));
}

// The database inserts the credential's canonical opaque client ID. Ignore only
// that ID when comparing separately generated synthetic requests; preserve all
// prompt instructions, roles, source text, dates, model and generation options.
function stableRequest(value: any) {
  const copy = structuredClone(value);
  for (const message of copy.messages ?? []) if (message.role === 'user') {
    try {
      const source = JSON.parse(message.content);
      if (Array.isArray(source.events)) {
        source.events = source.events.map((event: any) => ({ ...event, client_id: 'synthetic-client' }));
        message.content = JSON.stringify(source);
      }
    } catch { /* Repair instructions are plain text. */ }
  }
  return copy;
}

let relay: Server | undefined;
let databaseResource: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let appServer: Server | undefined;
const clients: Client[] = [];
let observer: ReturnType<typeof installDirectProviderObserver> | undefined;
try {
assert(!(holdout && taxonomy), 'Select only one frozen probe');
assert(!(legacyHoldout && process.argv.includes('--holdout')), 'Choose one holdout version');
assert(!legacyHoldout || ['--requests', '--replay'].includes(mode), 'Legacy holdout supports offline requests/replay only');
assert(['--live', '--requests', '--replay'].includes(mode) && args.length === (mode === '--replay' ? 2 : args.length === 0 ? 0 : 1), 'Invalid evaluation arguments');
recording = mode === '--replay' ? JSON.parse(await readFile(args[1], 'utf8')) : undefined;
if (recording) {
  assert.equal(recording.schema_version, 'threadkeeper.provider-evaluation-recording.v1');
  assert.deepEqual(recording.cases.map(item => item.id), corpus.map(item => item.id));
  if (boundedProbe) assert.equal((recording as any)[metadataKey]?.manifest_sha256, manifestSha256);
}
const config = providerConfigFromEnv();
if (boundedProbe) {
  // Local request generation/replay uses the same explicit measured settings.
  // Live mode must opt in via the environment rather than silently override it.
  if (mode !== '--live') config.reasoningEffort = 'none';
  assertHoldoutConfig(config);
  if (mode === '--live') {
    const cwd = new URL('..', import.meta.url);
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim(), '', 'Freeze and commit the probe before live inference');
    assert(config.apiKey, 'Probe requires configured provider credentials');
  }
}
if (mode !== '--live') {
  relay = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size < 1_000_000); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, DEFAULT_MODEL_ID);
      attempts.push({ request: body });
      let result: any = { model: DEFAULT_MODEL_ID, choices: [{ finish_reason: 'stop', message: { content: '{"memories":[]}' } }] };
      if (recording) {
        const expected = recording.cases.find(item => item.id === currentCase.id)!.attempts[replayOffset++];
        if (!expected) {
          mismatch = true;
          // Export the missing synthetic request for a separate fresh call,
          // while rejecting this run's fidelity rather than counting it as
          // an ordinary failed learned output.
          process.stderr.write(JSON.stringify({ id: currentCase.id, unrecorded_request: body }) + '\n');
          response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":"unrecorded_provider_attempt"}'); return;
        }
        assert.deepEqual(stableRequest(body), stableRequest(expected.request));
        if (expected.error) { response.writeHead(expected.error.status ?? 502, { 'Content-Type': 'application/json' }); response.end('{"error":"recorded_provider_failure"}'); return; }
        assert(expected.response, 'Recording lacks a provider response');
        result = expected.response;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch {
      mismatch = true;
      response.writeHead(409, { 'Content-Type': 'application/json' }); response.end('{"error":"evaluation_request_mismatch"}');
    }
  });
  await new Promise<void>(resolve => relay!.listen(0, '127.0.0.1', resolve));
  const address = relay.address(); assert(address && typeof address === 'object');
  config.baseUrl = `http://127.0.0.1:${address.port}/v1/`;
  config.apiKey = undefined;
  config.modelId = DEFAULT_MODEL_ID;
  config.jsonObject = true;
  config.structuredOutput = false;
  config.maxOutputTokens = 4096;
}
const provider = new OpenAICompatibleProvider(config);
if (mode === '--live') observer = installDirectProviderObserver(boundedProbe ? {
  baseUrls: [config.baseUrl], models: [config.modelId], limits: { ...holdoutRequestLimits, 'chat/completions': manifest.budget.max_chat_requests },
} : { ...providerObservationConfigFromEnv(), baseUrls: [config.baseUrl], models: [config.modelId] });
const database = databaseResource = await createTestDatabase();
  await bootstrap(database.db, 'provider-evaluation@example.invalid', 'synthetic-provider-password-123');
  appServer = createServer();
  await new Promise<void>(resolve => appServer!.listen(0, '127.0.0.1', resolve));
  const address = appServer.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const { app, store } = createApp(database.db, { origin: base });
  appServer.on('request', app);
  let cookie = '';
  async function http(path: string, options: { body?: any; method?: string; token?: string } = {}) {
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : cookie ? { cookie } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return { data: await response.json() as any, response };
  }
  const login = await http('/api/auth/login', { body: { email: 'provider-evaluation@example.invalid', password: 'synthetic-provider-password-123' } });
  cookie = login.response.headers.get('set-cookie')!.split(';')[0];
  const writer = (await http('/api/clients', { body: { name: 'Synthetic evaluation writer A', permissions: ['read', 'capture'], projects: null } })).data;
  const reader = (await http('/api/clients', { body: { name: 'Synthetic evaluation reader B', permissions: ['read'], projects: null } })).data;
  const a = new Client({ name: 'synthetic-provider-evaluation-a', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  const b = new Client({ name: 'synthetic-provider-evaluation-b', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  clients.push(a, b);
  for (const [client, token] of [[a, writer.token], [b, reader.token]] as const) await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  async function recall(client: Client, project: string, status?: string) {
    const result = await client.callTool({ name: 'context_search', arguments: { query: '', project_id: project, limit: 100, ...(status ? { status } : {}) } });
    assert.equal(result.isError, undefined);
    return (result.structuredContent as any).memories as any[];
  }
  for (const [index, item] of corpus.entries()) {
    currentCase = item; attempts = []; replayOffset = 0;
    const start = performance.now();
    const attemptStart = observer?.records.length ?? 0;
    currentProgress = { id: item.id, status: 'attempted', phase: 'capture', rubric_passed: false, attempt_start: attemptStart };
    // Assessment category names stay out of the provider's runtime context.
    // Preserve the historical corpus context for comparable old recordings.
    const project = boundedProbe ? `project-${String(index + 1).padStart(2, '0')}` : `synthetic-evaluation-${item.id}`;
    const captured = await a.callTool({ name: 'context_capture', arguments: { idempotency_key: `synthetic-evaluation-${item.id}`, project_id: project, subject: 'self', events: item.events } });
    assert.equal(captured.isError, undefined);
    const receipt = captured.structuredContent as any;
    assert.equal(receipt.status, 'pending');
    currentProgress.phase = 'extraction';
    const job = await store.processJob(provider);
    assert(job);
    Object.assign(currentProgress, { job_status: job.status, accepted: job.accepted, phase: 'recall',
      ...('error_code' in job ? { error_code: job.error_code } : {}) });
    if (mismatch) throw new Error('Recorded request mismatch or unrecorded repair; obtain a fresh exact learned response.');
    if (recording) assert.equal(replayOffset, recording.cases.find(value => value.id === item.id)!.attempts.length, 'Unused recorded attempts');
    requests.push({ id: item.id, attempts });
    const active = await recall(b, project);
    const candidates = await recall(b, project, 'candidate');
    const canonical = [...active, ...candidates];
    if (boundedProbe) currentProgress.canonical_memories = canonical;
    const first = [...await recall(a, project), ...await recall(a, project, 'candidate')];
    const independentHttp = [
      ...(await http(`/api/context/search?project_id=${encodeURIComponent(project)}&limit=100`, { token: reader.token })).data.memories,
      ...(await http(`/api/context/search?project_id=${encodeURIComponent(project)}&limit=100&status=candidate`, { token: reader.token })).data.memories,
    ];
    currentProgress.phase = 'transport_comparison';
    if (boundedProbe) currentProgress.transport_records = { reader_mcp: canonical, writer_mcp: first, http: independentHttp };
    assert(active.every(memory => !['assistant_proposed', 'inferred'].includes(memory.origin)), 'Unconfirmed candidates must not enter default recall');
    const records = (memories: any[]) => memories.map(memory => ({
      ...memory,
      evidence: memory.evidence.map((value: any) => ({ ...value })).sort((a: any, b: any) => a.source_id.localeCompare(b.source_id)),
    })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(records(first), records(canonical));
    assert.deepEqual(records(independentHttp), records(canonical));
    const sourceRows = boundedProbe
      ? (await database.db.query('SELECT * FROM tk_sources WHERE project_id=$1', [project])).rows
      : (await database.db.query('SELECT id,event_id,text FROM tk_sources WHERE id=ANY($1::text[])', [canonical.flatMap(memory => memory.evidence.map((evidence: any) => evidence.source_id))])).rows;
    if (boundedProbe) {
      currentProgress.phase = 'source_provenance';
      currentProgress.source_events = sourceRows.map(({ owner_id: _owner, ...source }) => source);
      assertHoldoutRecords(item, canonical, sourceRows, { project, client_id: writer.client.id });
    }
    const sourceById = new Map(sourceRows.map(source => [source.id, source]));
    const memories = canonical.map(memory => ({ statement: memory.statement, kind: memory.kind, origin: memory.origin, status: memory.status,
      effective_at: memory.effective_at, evidence: memory.evidence.map((evidence: any) => ({ event_id: sourceById.get(evidence.source_id)?.event_id, quote: evidence.quote })),
    }));
    const rubric = taxonomy ? evaluateTaxonomyOutcome(item as TaxonomyCase, memories, job) : holdout ? evaluateHoldoutOutcome(item, memories, job) : evaluateMemoryRubric(item, memories);
    output.push({ id: item.id, job_status: job.status, accepted: job.accepted,
      ...(boundedProbe ? { status: 'measured', canonical_memories: canonical, source_events: currentProgress.source_events } : {}),
      ...('error_code' in job ? { error_code: job.error_code } : {}),
      ...(observer ? { provider_attempts: observer.records.slice(attemptStart) } : {}),
      usage: 'usage' in job ? job.usage : undefined, ...rubric,
      empty_expected: item.empty ?? false, independent_http_mcp_recall: true, memories,
      elapsed_ms: Math.round(performance.now() - start),
      rubric_passed: job.status === 'complete' && rubric.rubric_passed,
    });
    currentProgress = undefined;
  }
  const lifecycle: Record<string, any> = boundedProbe ? { status: 'not_measured', reason: lifecycleReason } : { status: 'skipped', reason: 'central_records_missing' };
  if (!boundedProbe) {
  const memories = await recall(b, 'synthetic-evaluation-direct');
  const deadline = memories.find(memory => /October 20|2026-10-20|20 October/i.test(memory.statement));
  const preference = memories.find(memory => /short paragraphs/i.test(memory.statement));
  if (mode !== '--requests' && deadline && preference) {
    const corrected = 'The Lumen demo deadline is October 27, 2026.';
    await http(`/api/memories/${deadline.id}`, { method: 'PATCH', body: { statement: corrected, expected_revision: deadline.revision } });
    const preview = (await http(`/api/memories/${preference.id}/deletion-preview`)).data;
    await http(`/api/memories/${preference.id}`, { method: 'DELETE', body: { expected_revision: preference.revision, preview_hash: preview.preview_hash } });
    for (const client of [a, b]) assert.deepEqual((await recall(client, 'synthetic-evaluation-direct')).map(memory => memory.statement), [corrected]);
    const archive = (await http('/api/export')).data;
    assert(!JSON.stringify(archive).includes('I prefer short paragraphs when writing project updates.'));
    Object.assign(lifecycle, { status: 'passed', corrected_deadline: true, forgotten_preference: true, fresh_independent_recalls: 2, export_removed_deleted_evidence: true });
    delete lifecycle.reason;
  }
  }
  const observationEvidence = boundedProbe && observer ? assessHoldoutObservations(output, observer.records, corpus.length) : undefined;
  report(mode === '--requests' ? { schema_version: 'threadkeeper.provider-evaluation-recording.v1', ...probeMetadata(), cases: requests } : {
    schema_version: 'threadkeeper.provider-evaluation.v1', measured_at: new Date().toISOString(), model: provider.config.modelId,
    transport: mode === '--replay' ? boundedProbe ? 'recorded_responses_over_local_http_adapter' : 'recorded_learned_executor_responses_over_local_http_adapter' : 'direct_operator_http_provider',
    database: database.backend, cases: output, central_lifecycle: lifecycle,
    ...probeMetadata(),
    ...(observationEvidence ? { observation_evidence: observationEvidence } : {}),
    reasoning_effort: provider.config.reasoningEffort ?? null,
    ...(observer ? { provider_accounting: summarizeProviderObservations(observer.records), observation_errors: observer.errors,
      provider_timing: 'Each attempt measures direct fetch through complete response-body observation; case times also include capture/admission/recall.' } : {}),
    limits: ['Small fixed synthetic corpus; rubric matching is not a broad semantic quality estimate.', 'Replay timing measures local admission/recall; original inference latency belongs to the recording.', 'Independent SDK transports are not installed chatbot hosts.', 'No GPU, native container, deployment, or provider credential export.'],
  });
  if (mode !== '--requests' && (observer?.errors.length || output.some(item => !item.rubric_passed) || observationEvidence?.status === 'incomplete' || (!boundedProbe && lifecycle.status !== 'passed'))) process.exitCode = 1;
} catch (error) {
  // Preserve usage and completed rubrics even if an application/lifecycle
  // assertion aborts the run. Do not serialize raw errors or provider bodies.
  if (boundedProbe && currentProgress) {
    const { attempt_start, ...progress } = currentProgress;
    output.push({ ...progress, status: 'failed', reason: 'evaluation_assertion_failed',
      ...(observer ? { provider_attempts: observer.records.slice(attempt_start) } : {}) });
  }
  if (boundedProbe) for (const item of corpus) if (!output.some(value => value.id === item.id)) output.push({ id: item.id, status: 'not_attempted', rubric_passed: false });
  if (mode === '--live' || boundedProbe) report({
    schema_version: 'threadkeeper.provider-evaluation.v1', measured_at: new Date().toISOString(),
    transport: mode === '--live' ? 'direct_operator_http_provider' : 'local_http_fixture', status: 'failed', reason: 'evaluation_aborted',
    ...probeMetadata(),
    ...(boundedProbe && mode === '--live' ? { observation_evidence: assessHoldoutObservations(output, observer?.records ?? [], corpus.length),
      provider_accounting: summarizeProviderObservations(observer?.records ?? []) } : {}),
    cases: output, central_lifecycle: boundedProbe ? { status: 'not_measured', reason: lifecycleReason } : { status: 'incomplete' },
    ...(observer ? { provider_accounting: summarizeProviderObservations(observer.records),
      provider_attempts: observer.records, observation_errors: observer.errors } : {}),
  });
  if (!boundedProbe) throw error;
  process.exitCode = 1;
} finally {
  observer?.restore();
  const cleanup = await Promise.allSettled([
    ...clients.map(client => client.close()),
    ...[appServer, relay].filter((server): server is Server => Boolean(server?.listening)).map(async server => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }),
    ...(databaseResource ? [databaseResource.close()] : []),
  ]);
  const cleanupFailed = cleanup.some(result => result.status === 'rejected');
  if (boundedProbe && deferredReport) {
    if (cleanupFailed) Object.assign(deferredReport, { status: 'failed', reason: 'provider_evaluation_cleanup_failed' });
    deferredReport.cleanup = { status: cleanupFailed ? 'failed' : 'passed' };
    console.info(JSON.stringify(deferredReport, null, 2));
  }
  if (cleanupFailed) {
    if (boundedProbe) process.exitCode = 1;
    else throw new Error('provider_evaluation_cleanup_failed');
  }
}
