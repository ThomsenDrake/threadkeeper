import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { CaptureSchema, SearchSchema } from '../packages/contracts/src/index.ts';
import { assertLearnedRecall, directLearnedCase } from './integration/learned-assertions.ts';

export const opencodeProject = 'synthetic-installed-opencode';
export const correctedDeadline = 'The Lumen demo deadline is October 27, 2026.';
export type HostPhase = 'capture-a' | 'recall-b' | 'fresh-a' | 'fresh-b';
export type McpEvidence = { phase: HostPhase; client_id: string; rpc_id: string | number; tool: string;
  arguments: Record<string, unknown>; http_status: number; result: any };
export const phaseTool = (phase: HostPhase) => phase === 'capture-a' ? 'context_capture' : 'context_search';
export type McpPhase = { id: HostPhase; client_id: string; token: string; started: number; rpc_ids: Set<string | number> };

export function parseMcpToolResponse(text: string, contentType: string, id: string | number) {
  let responses: any[];
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const normalized = text.replaceAll('\r\n', '\n');
    assert(normalized.endsWith('\n\n'), 'Incomplete MCP event stream');
    responses = normalized.split('\n\n').filter(Boolean).flatMap(frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      return data ? [JSON.parse(data)] : [];
    }).filter(response => response.id !== undefined || typeof response.method !== 'string');
  } else {
    assert(contentType.toLowerCase().includes('application/json'), 'Unexpected MCP response type');
    responses = [JSON.parse(text)];
  }
  assert.equal(responses.length, 1, 'Missing or duplicate MCP response');
  const response = responses[0];
  assert.equal(response.id, id, 'MCP request/response identity differs');
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.error, undefined, 'MCP RPC response failed');
  assert(response.result && response.result.isError !== true && response.result.structuredContent, 'MCP tool failed or omitted canonical data');
  assert.equal(response.result.content?.length, 1, 'Unexpected MCP content');
  assert.equal(response.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent, 'MCP text and structured results differ');
  return response.result.structuredContent;
}

/** A bounded tap of the application's actual MCP response; no relay. */
export function observeMcpCall(req: Request, res: Response, phase: McpPhase,
  records: McpEvidence[], failures: string[]) {
  const body = req.body;
  if (body?.method !== 'tools/call') return;
  assert(req.headers.authorization === `Bearer ${phase.token}`, 'MCP request used the wrong phase credential');
  assert(typeof body.id === 'string' || Number.isSafeInteger(body.id), 'MCP tool call omitted its RPC identity');
  assert.equal(body.params?.name, phaseTool(phase.id), 'Host called an unexpected phase tool');
  assert(++phase.started <= (phase.id === 'capture-a' ? 1 : 4), 'Host exceeded its MCP call budget');
  assert(!phase.rpc_ids.has(body.id), 'Duplicate MCP request identity'); phase.rpc_ids.add(body.id);
  const chunks: Buffer[] = []; let size = 0, overflow = false;
  const observe = (chunk: unknown) => {
    if (chunk === undefined || chunk === null) return;
    const value = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
    size += value.length;
    if (size > 512_000) { overflow = true; chunks.length = 0; return; }
    if (!overflow) chunks.push(value);
  };
  const write = res.write.bind(res), end = res.end.bind(res);
  res.write = ((chunk: unknown, ...args: any[]) => { observe(chunk); return (write as any)(chunk, ...args); }) as typeof res.write;
  res.end = ((chunk: unknown, ...args: any[]) => { observe(chunk); return (end as any)(chunk, ...args); }) as typeof res.end;
  res.once('finish', () => {
    try {
      assert(!overflow, 'MCP response exceeded observation limit');
      const result = parseMcpToolResponse(Buffer.concat(chunks).toString('utf8'), String(res.getHeader('content-type')), body.id);
      records.push({ phase: phase.id, client_id: phase.client_id, rpc_id: body.id, tool: body.params.name,
        arguments: structuredClone(body.params.arguments), http_status: res.statusCode, result });
    } catch { failures.push('mcp_response_observation_failed'); }
  });
  res.once('close', () => { if (!res.writableFinished) failures.push('mcp_response_interrupted'); });
}

export function assertCaptureEvidence(records: McpEvidence[]) {
  assert.equal(records.length, 1, 'Expected one model-selected source-only capture');
  const record = records[0];
  assert.equal(record.phase, 'capture-a'); assert.equal(record.tool, 'context_capture'); assert.equal(record.http_status, 200);
  assert(!Object.hasOwn(record.arguments, 'explicit_memories'), 'The host must not fabricate explicit extracted memories');
  const input = CaptureSchema.parse(record.arguments);
  assert.equal(input.project_id, opencodeProject); assert.equal(input.subject, 'self');
  assert.equal(input.idempotency_key, 'installed-opencode-capture');
  assert.deepEqual(input.events, directLearnedCase.events, 'The host changed the authorized source events');
  assert.equal(record.result.status, 'pending');
  assert.deepEqual(record.result.memory_ids, []);
  assert.equal(record.result.source_ids.length, 2); assert.equal(new Set(record.result.source_ids).size, 2);
  assert(record.result.job_id && record.result.capture_id);
  return record.result;
}

export function assertRecallEvidence(records: McpEvidence[], phase: Exclude<HostPhase, 'capture-a'>, canonical: any[]) {
  assert(records.length >= 1 && records.length <= 4, 'Expected bounded model-selected recall');
  assert.equal(new Set(records.map(record => record.rpc_id)).size, records.length, 'Duplicate MCP request identity');
  for (const record of records) {
    assert.equal(record.phase, phase); assert.equal(record.tool, 'context_search'); assert.equal(record.http_status, 200);
    const input = SearchSchema.parse(record.arguments);
    assert.equal(input.project_id, opencodeProject);
    assert.equal(input.query, '', 'This central flow requests complete full-text state without answer hints');
    assert(input.status === undefined || input.status === 'active');
    assert.deepEqual(record.result.memories.map((memory: any) => memory.id).sort(), canonical.map(memory => memory.id).sort(), 'Host recall omitted or fabricated a canonical record');
    assertLearnedRecall(record.result.memories, canonical);
    assert.equal(record.result.coverage.semantic_search, 'not_requested');
    assert.equal(record.result.coverage.retrieval, 'postgresql_full_text');
  }
}
