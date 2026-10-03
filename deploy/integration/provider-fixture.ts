import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { SourceEventSchema } from '../../packages/contracts/src/index.ts';
import { DEFAULT_MODEL_ID } from '../../packages/providers/src/index.ts';

// This is synthetic HTTP integration data, never a learned model or a fallback
// for an operator's configured provider. Controls are internal to the disposable
// integration network and deliberately contain no captured text or credentials.
export const FIXTURE_EMBEDDING_MODEL = 'threadkeeper-fixture-embedding-v1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HELD_REQUESTS = 128;
const ModelSchema = z.string().min(1).max(200);
const ConfigureSchema = z.object({
  chatMode: z.enum(['ok', 'http-error', 'wrong-model']).optional(),
  embeddingMode: z.enum(['ok', 'http-error', 'wrong-model', 'wrong-dimensions']).optional(),
  holdChat: z.boolean().optional(),
  holdEmbeddings: z.boolean().optional(),
}).strict();
const ChatSchema = z.object({
  model: ModelSchema,
  messages: z.array(z.object({ role: z.string(), content: z.string().max(200_000).optional().nullable() }).passthrough()).min(1).max(8),
}).passthrough();
const ExtractionSchema = z.object({
  events: z.array(SourceEventSchema).min(1).max(32),
}).passthrough().refine(input => input.events.reduce((sum, event) => sum + event.text.length, 0) <= 64_000);
const EmbeddingSchema = z.object({
  model: ModelSchema,
  input: z.union([z.string().min(1).max(16_000), z.array(z.string().min(1).max(16_000)).min(1).max(64)]),
  dimensions: z.literal(3).optional(),
}).passthrough();

type Snapshot = { status: number; body: string };
type HeldRequest = { response: ServerResponse; snapshot: Snapshot; complete: (snapshot: Snapshot) => void };

function snapshot(status: number, value: unknown): Snapshot {
  return { status, body: JSON.stringify(value) };
}

function send(response: ServerResponse, value: Snapshot): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(value.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(value.body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request_too_large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function embedding(text: string): number[] {
  if (/milestones and prose style/i.test(text)) return [1, 1, 0];
  if (/deadline|time|schedule/i.test(text)) return [1, 0, 0];
  if (/preference|writing|paragraph|concise/i.test(text)) return [0, 1, 0];
  return [0, 0, 1];
}

export function createFixture(options: { memoryModel?: string; embeddingModel?: string } = {}): Server {
  const memoryModel = options.memoryModel ?? DEFAULT_MODEL_ID;
  const embeddingModel = options.embeddingModel ?? FIXTURE_EMBEDDING_MODEL;
  let configuration: z.infer<typeof ConfigureSchema> = { chatMode: 'ok', embeddingMode: 'ok', holdChat: false, holdEmbeddings: false };
  let generation = 0;
  let chatRequests = 0;
  let embeddingRequests = 0;
  let completedChat = 0;
  let completedEmbeddings = 0;
  let authorizationSeen = false;
  const models = new Set<string>();
  const dimensions = new Set<number>();
  const heldChat = new Set<HeldRequest>();
  const heldEmbeddings = new Set<HeldRequest>();

  function release(queue: Set<HeldRequest>, reset = false): void {
    for (const request of queue) request.complete(reset ? snapshot(503, { error: 'fixture_reset' }) : request.snapshot);
    queue.clear();
  }

  function deliver(kind: 'chat' | 'embeddings', response: ServerResponse, output: Snapshot): void {
    const requestGeneration = generation;
    const queue = kind === 'chat' ? heldChat : heldEmbeddings;
    const complete = (value: Snapshot) => {
      queue.delete(held);
      send(response, value);
    };
    const held: HeldRequest = { response, snapshot: output, complete };
    response.once('finish', () => {
      if (requestGeneration !== generation) return;
      if (kind === 'chat') completedChat += 1;
      else completedEmbeddings += 1;
    });
    response.once('close', () => queue.delete(held));
    if (kind === 'chat' ? configuration.holdChat : configuration.holdEmbeddings) {
      if (heldChat.size + heldEmbeddings.size >= MAX_HELD_REQUESTS) complete(snapshot(503, { error: 'fixture_hold_limit' }));
      else queue.add(held);
    } else complete(output);
  }

  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0];
    try {
      if (request.method === 'GET' && path === '/control/status') {
        send(response, snapshot(200, {
          chatRequests, embeddingRequests,
          heldChat: heldChat.size, heldEmbeddings: heldEmbeddings.size,
          completedChat, completedEmbeddings,
          models: [...models].sort(), dimensions: [...dimensions].sort((a, b) => a - b), authorizationSeen,
        }));
        return;
      }
      if (request.method === 'GET' && path === '/v1/models') {
        send(response, snapshot(200, { object: 'list', data: [memoryModel, embeddingModel].map(id => ({ id, object: 'model', owned_by: 'synthetic-fixture' })) }));
        return;
      }
      if (request.method !== 'POST') {
        send(response, snapshot(404, { error: 'fixture_route_not_found' }));
        return;
      }
      const body = await readJson(request);
      if (path === '/control/reset') {
        generation += 1;
        release(heldChat, true);
        release(heldEmbeddings, true);
        configuration = { chatMode: 'ok', embeddingMode: 'ok', holdChat: false, holdEmbeddings: false };
        chatRequests = embeddingRequests = completedChat = completedEmbeddings = 0;
        authorizationSeen = false;
        models.clear();
        dimensions.clear();
        send(response, snapshot(200, { status: 'reset' }));
        return;
      }
      if (path === '/control/configure') {
        const parsed = ConfigureSchema.safeParse(body);
        if (!parsed.success) { send(response, snapshot(400, { error: 'fixture_invalid_configuration' })); return; }
        configuration = { ...configuration, ...parsed.data };
        send(response, snapshot(200, { status: 'configured' }));
        return;
      }
      if (path === '/control/release') {
        configuration.holdChat = configuration.holdEmbeddings = false;
        release(heldChat);
        release(heldEmbeddings);
        send(response, snapshot(200, { status: 'released' }));
        return;
      }
      if (path === '/v1/chat/completions') {
        chatRequests += 1;
        authorizationSeen ||= Boolean(request.headers.authorization);
        const parsed = ChatSchema.safeParse(body);
        if (!parsed.success) { deliver('chat', response, snapshot(400, { error: 'fixture_invalid_chat_request' })); return; }
        models.add(parsed.data.model);
        if (parsed.data.model !== memoryModel) { deliver('chat', response, snapshot(400, { error: 'fixture_unconfigured_memory_model' })); return; }
        if (configuration.chatMode === 'http-error') { deliver('chat', response, snapshot(503, { error: 'fixture_chat_failure' })); return; }
        let extraction: z.infer<typeof ExtractionSchema> | undefined;
        for (const message of parsed.data.messages) {
          if (message.role !== 'user' || !message.content) continue;
          try {
            const candidate = ExtractionSchema.safeParse(JSON.parse(message.content));
            if (candidate.success) { extraction = candidate.data; break; }
          } catch { /* Repair messages are plain text, with no source payload. */ }
        }
        if (!extraction || extraction.events.some(event => event.text.length > 4000)) {
          deliver('chat', response, snapshot(400, { error: 'fixture_invalid_extraction_input' }));
          return;
        }
        const memories = extraction.events.flatMap(event => {
          const memory = {
            statement: event.text, kind: /paragraph|writing|prefer/i.test(event.text) ? 'preference' : 'fact',
            source_event_id: event.id, quote: event.text, origin: event.origin,
            subject: null, effective_at: null,
          };
          return event.id === 'writing-v1' && memory.kind === 'preference'
            ? [memory, { ...memory, statement: 'The writer may favor concise explanations.', origin: 'inferred' }]
            : [memory];
        });
        deliver('chat', response, snapshot(200, {
          id: 'synthetic-extraction', object: 'chat.completion',
          model: configuration.chatMode === 'wrong-model' ? 'synthetic-substituted-memory-model' : memoryModel,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ memories }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }));
        return;
      }
      if (path === '/v1/embeddings') {
        embeddingRequests += 1;
        authorizationSeen ||= Boolean(request.headers.authorization);
        const parsed = EmbeddingSchema.safeParse(body);
        if (!parsed.success) { deliver('embeddings', response, snapshot(400, { error: 'fixture_invalid_embedding_request' })); return; }
        models.add(parsed.data.model);
        if (parsed.data.dimensions !== undefined) dimensions.add(parsed.data.dimensions);
        if (parsed.data.model !== embeddingModel) { deliver('embeddings', response, snapshot(400, { error: 'fixture_unconfigured_embedding_model' })); return; }
        if (configuration.embeddingMode === 'http-error') { deliver('embeddings', response, snapshot(503, { error: 'fixture_embedding_failure' })); return; }
        const texts = typeof parsed.data.input === 'string' ? [parsed.data.input] : parsed.data.input;
        deliver('embeddings', response, snapshot(200, {
          object: 'list', model: configuration.embeddingMode === 'wrong-model' ? 'synthetic-substituted-embedding-model' : embeddingModel,
          data: texts.map((text, index) => ({ object: 'embedding', index, embedding: configuration.embeddingMode === 'wrong-dimensions' ? [...embedding(text), 0] : embedding(text) })),
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }));
        return;
      }
      send(response, snapshot(404, { error: 'fixture_route_not_found' }));
    } catch (error) {
      send(response, snapshot(error instanceof Error && error.message === 'request_too_large' ? 413 : 400, { error: 'fixture_invalid_body' }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.once('close', () => { release(heldChat, true); release(heldEmbeddings, true); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Fixture PORT must be a valid port');
  const server = createFixture({
    memoryModel: process.env.FIXTURE_MEMORY_MODEL || DEFAULT_MODEL_ID,
    embeddingModel: process.env.FIXTURE_EMBEDDING_MODEL || FIXTURE_EMBEDDING_MODEL,
  });
  server.listen(port, '0.0.0.0', () => console.info(JSON.stringify({ event: 'synthetic_provider_fixture_started', port })));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
