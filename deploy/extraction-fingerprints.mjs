import { createHash } from 'node:crypto';
import { z } from 'zod';

// Independent, bounded equality evidence for the native synthetic lifecycle.
// Never emit model content, source text, identifiers or raw parsing errors.
export const extractionCanonicalVersion = 'threadkeeper-extraction-v1';
const Identifier = z.string().min(1).max(200);
const Timestamp = z.string().datetime({ offset: true });
const Origin = z.enum(['user_explicit', 'user_confirmed', 'assistant_proposed', 'agent_reported', 'inferred']);
const Kind = z.enum(['fact', 'preference', 'decision', 'constraint', 'project_state']);
const Memory = z.object({ statement: z.string().min(1).max(4000), kind: Kind, source_event_id: Identifier,
  quote: z.string().min(1).max(24000), origin: Origin, subject: Identifier.nullish(), effective_at: Timestamp.nullish() }).strict();
const Source = z.object({ id: Identifier, text: z.string().min(1).max(24000),
  author_role: z.enum(['user', 'assistant', 'system', 'unknown']), origin: Origin,
  occurred_at: Timestamp.nullish(), client_id: Identifier.optional() });
const Context = z.object({ project_id: Identifier.nullish(), subject: Identifier.nullish(), events: z.array(Source).min(1).max(32) });
const CanonicalRecord = z.object({ ...Memory.shape, project_id: Identifier.nullable(), subject: Identifier,
  status: z.enum(['active', 'candidate']), effective_at: Timestamp.nullable() }).strict();
const ChatResponse = z.object({
  model: z.string().min(1).refine(model => model.trim() === model && !/[\u0000-\u001f\u007f]/.test(model)).optional(),
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({
    content: z.string().nullable().optional(), refusal: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }) })).nullable().optional(),
  }) })).min(1).max(64),
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => value == null ? null : new Date(value).toISOString();

function contextValue(raw) {
  const parsed = Context.safeParse(raw);
  if (!parsed.success || parsed.data.events.reduce((sum, event) => sum + event.text.length, 0) > 64000) return undefined;
  const context = parsed.data;
  if (new Set(context.events.map(event => event.id)).size !== context.events.length) return undefined;
  return { ...context, project_id: context.project_id ?? null, subject: context.subject ?? 'self' };
}

/** Canonicalize already-persisted fields; do not repair attribution or text. */
export function extractionRecordsFingerprint(rawRecords, rawContext) {
  const context = contextValue(rawContext), parsed = z.array(CanonicalRecord).max(64).safeParse(rawRecords);
  if (!context || !parsed.success) return undefined;
  const sources = new Map(context.events.map(source => [source.id, source]));
  const records = [];
  for (const memory of parsed.data) {
    const source = sources.get(memory.source_event_id);
    if (!source || !source.text.includes(memory.quote) || memory.subject !== context.subject || memory.project_id !== context.project_id) return undefined;
    records.push(hash([memory.project_id, memory.subject, memory.statement, memory.kind, memory.origin,
      memory.status, timestamp(memory.effective_at), memory.source_event_id, memory.quote]));
  }
  const inputs = context.events.map(event => [event.id, event.text, event.author_role, event.origin,
    timestamp(event.occurred_at), event.client_id ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { canonical_version: extractionCanonicalVersion, input_sha256: hash([context.project_id, context.subject, inputs]),
    memory_count: records.length, memories_sha256: hash(records.sort()) };
}

/** Normalize only the transformations made by the actual adapter and store. */
export function extractionResponseFingerprint(request, response) {
  if (!Array.isArray(request?.messages) || request.messages.length > 8) return undefined;
  const outer = ChatResponse.safeParse(response);
  if (!outer.success || (outer.data.model !== undefined && outer.data.model !== request.model)) return undefined;
  const input = request.messages.find(message => message?.role === 'user')?.content;
  const choice = outer.data.choices[0];
  const content = choice?.message?.content;
  if (typeof input !== 'string' || input.length > 100000 || typeof content !== 'string' || content.length > 2000000
    || choice.message.refusal || choice.finish_reason === 'length' || choice.message.tool_calls?.length) return undefined;
  let rawContext, object;
  try { rawContext = JSON.parse(input); object = JSON.parse(content); } catch { return undefined; }
  const context = contextValue(rawContext), parsed = z.object({ memories: z.array(Memory).max(64) }).strict().safeParse(object);
  if (!context || !parsed.success) return undefined;
  const events = new Map(context.events.map(event => [event.id, event]));
  const memories = [];
  for (const memory of parsed.data.memories) {
    const source = events.get(memory.source_event_id);
    if (!source || !source.text.includes(memory.quote) || (memory.subject != null && memory.subject !== context.subject)
      || (memory.effective_at && !memory.quote.includes(memory.effective_at))) return undefined;
    let origin = memory.origin;
    if (source.origin === 'agent_reported' && ['user_explicit', 'user_confirmed'].includes(origin)) origin = 'agent_reported';
    if (origin === 'user_explicit' || origin === 'user_confirmed') {
      if (source.author_role !== 'user' || !['user_explicit', 'user_confirmed'].includes(source.origin)) {
        origin = source.author_role === 'assistant' ? 'assistant_proposed' : 'inferred';
      } else origin = source.origin;
    }
    memories.push({ ...memory, origin, subject: memory.subject ?? context.subject, project_id: context.project_id,
      status: ['inferred', 'assistant_proposed'].includes(origin) ? 'candidate' : 'active', effective_at: memory.effective_at ?? null });
  }
  return extractionRecordsFingerprint(memories, context);
}
