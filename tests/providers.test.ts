import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExplicitMemory, SourceEvent } from '../packages/contracts/src/index.ts';
import { literalReportBoundaryControls, literalReportRepairControls, literalReportSkipControls } from './fixtures/literal-report-controls.ts';
import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
  ProviderError,
  createEmbeddingProvider,
  embeddingConfigFromEnv,
  providerConfigFromEnv,
  type ProviderConfig,
} from '../packages/providers/src/index.ts';

type FakeRequest = { path?: string; authorization?: string; body: Record<string, unknown> };

async function withFakeEndpoint(run: (baseUrl: string, requests: FakeRequest[]) => Promise<void>, replies: unknown[]) {
  const requests: FakeRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ path: new URL(String(input)).pathname, authorization: headers.get('Authorization') || undefined, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify(replies[Math.min(requests.length - 1, replies.length - 1)]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { await run('http://127.0.0.1:8080/v1/', requests); }
  finally { globalThis.fetch = originalFetch; }
}

function config(baseUrl: string): ProviderConfig {
  return { ...providerConfigFromEnv({}), baseUrl, timeoutMs: 1000 };
}

function completion(content: string) {
  return { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
}

const event = { id: 'event-1', text: 'I prefer short paragraphs.', author_role: 'user' as const, origin: 'user_explicit' as const };
const memory = { statement: 'Prefers short paragraphs.', kind: 'preference', source_event_id: event.id, quote: event.text, origin: 'user_explicit', subject: null, effective_at: null };

test('literal reports repair stripped attribution without filling or mutating source evidence', async () => {
  for (const sample of literalReportRepairControls) for (const fullQuote of [false, true]) {
    const source: SourceEvent = { id: 'report-source', author_role: 'assistant', origin: 'agent_reported',
      text: `${sample.reporter} reports: "${sample.assertion}"${sample.outsidePeriod ? '.' : ''}` };
    const before = structuredClone(source);
    const missing = { ...memory, source_event_id: source.id, statement: sample.assertion,
      kind: 'project_state', origin: fullQuote ? 'user_explicit' : 'agent_reported', quote: fullQuote ? source.text : sample.assertion };
    const repaired = { ...missing, origin: 'agent_reported', statement: source.text, quote: source.text };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 2);
      assert.deepEqual(result.memories, [{ statement: source.text, kind: 'project_state', source_event_id: source.id, quote: source.text, origin: 'agent_reported' }]);
      assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 });
      assert.deepEqual(source, before);
      const initial = requests[0].body.messages as Array<{ content: string }>;
      const repair = requests[1].body.messages as Array<{ content: string }>;
      assert.deepEqual(JSON.parse(initial[1].content).events, [before]);
      assert.equal(repair[1].content, initial[1].content);
      assert.match(repair.at(-1)!.content, /extraction_missing_report_attribution/);
      assert.match(repair.at(-1)!.content, /Retain the original named reporter/);
      assert.equal(requests[1].body.model, requests[0].body.model);
    }, [completion(JSON.stringify({ memories: [missing] })), completion(JSON.stringify({ memories: [repaired] }))]);
  }
});

test('repeated literal report omission rejects the entire batch after exactly one repair', async () => {
  const source: SourceEvent = { id: 'report-source', author_role: 'assistant', origin: 'agent_reported', text: 'Iris reports: "The backup is complete."' };
  const missing = { ...memory, source_event_id: source.id, statement: 'The backup is complete.', quote: 'The backup is complete.', kind: 'fact', origin: 'agent_reported' };
  await withFakeEndpoint(async (baseUrl, requests) => {
    let admitted: unknown;
    await assert.rejects(async () => { admitted = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event, source] }); },
      error => error instanceof ProviderError && error.code === 'extraction_missing_report_attribution'
        && error.message === 'extraction_missing_report_attribution');
    assert.equal(requests.length, 2);
    assert.equal(admitted, undefined, 'A valid first memory cannot escape a failed extraction batch.');
  }, [completion(JSON.stringify({ memories: [memory, missing] }))]);
});

test('literal report attribution preserves attributed records and conservative skip controls', async () => {
  type Control = { name: string; source: string; statement: string; quote: string; author_role?: SourceEvent['author_role']; origin?: SourceEvent['origin']; memory_origin?: ExplicitMemory['origin'] };
  const controls: readonly Control[] = [...literalReportSkipControls,
    { name: 'indefinite role descriptor', source: 'The someone monitor reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
    { name: 'unknown role descriptor', source: 'The unknown worker reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
    { name: 'wrong original role', source: 'Iris reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.', author_role: 'system' },
  ];
  for (const sample of controls) {
    const source: SourceEvent = { id: 'report-source', text: sample.source,
      author_role: sample.author_role ?? 'assistant', origin: sample.origin ?? 'agent_reported' };
    const candidate = { ...memory, source_event_id: source.id, statement: sample.statement,
      kind: 'fact', origin: sample.memory_origin ?? source.origin, quote: sample.quote };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 1, sample.name);
      const { subject: _subject, effective_at: _time, ...expected } = candidate;
      assert.deepEqual(result.memories, [expected], sample.name);
    }, [completion(JSON.stringify({ memories: [candidate] }))]);
  }
});

test('literal report guard respects its name token, whitespace and length envelope', async () => {
  for (const sample of literalReportBoundaryControls) {
    const source: SourceEvent = { id: 'report-source', text: `${sample.reporter} reports: "${sample.assertion}"`, author_role: 'assistant', origin: 'agent_reported' };
    const candidate = { ...memory, source_event_id: source.id, statement: sample.statement, quote: sample.assertion, origin: 'agent_reported' };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const extract = () => new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      if (sample.reject) await assert.rejects(extract, error => error instanceof ProviderError && error.code === 'extraction_missing_report_attribution');
      else assert.equal((await extract()).memories[0].statement, sample.statement);
      assert.equal(requests.length, sample.reject ? 2 : 1);
    }, [completion(JSON.stringify({ memories: [candidate] }))]);
  }
});

test('provider refuses fabricated evidence after one retry and preserves the model', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    await assert.rejects(provider.extract({ events: [event] }), error => error instanceof ProviderError && error.code === 'extraction_invalid_evidence');
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.body.model, 'nvidia/Nemotron-3_5-Lightning');
    assert.equal(requests[1]?.body.model, requests[0]?.body.model);
    assert.deepEqual(requests[0]?.body.response_format, { type: 'json_object' });
    assert.equal(requests[1]?.body.response_format, undefined);
    assert.equal(requests[0]?.authorization, undefined);
  }, [completion(JSON.stringify({ memories: [{ ...memory, quote: 'Fabricated quotation' }] }))]);
});

test('valid exact evidence is admitted and nullable optional schema fields are omitted', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 1);
    assert.equal(result.memories[0]?.origin, 'user_explicit');
    assert.equal(result.memories[0]?.subject, undefined);
    assert.equal(result.memories[0]?.effective_at, undefined);
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  }, [completion(JSON.stringify({ memories: [memory] }))]);
});

test('OpenAI-compatible nullable tool calls admit JSON while real and malformed calls remain rejected', async () => {
  const response = completion(JSON.stringify({ memories: [memory] }));
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 1, 'A null tool_calls field means no tool calls and must not trigger paid repair.');
    assert.equal(result.memories[0]?.quote, event.text);
  }, [{ ...response, choices: [{ finish_reason: 'stop', message: { ...response.choices[0].message, refusal: null, tool_calls: null } }] }]);
  for (const tool_calls of [[{ id: 'synthetic-call', type: 'function', function: { name: 'unexpected', arguments: '{}' } }], {}]) {
    await withFakeEndpoint(async (baseUrl, requests) => {
      await assert.rejects(new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] }), error => error instanceof ProviderError
        && error.code === (Array.isArray(tool_calls) ? 'extraction_missing_json_content' : 'provider_invalid_chat_response'));
      assert.equal(requests.length, 2, 'Tool-bearing and malformed outputs receive only one bounded repair.');
    }, [{ ...response, choices: [{ finish_reason: 'stop', message: { ...response.choices[0].message, tool_calls } }] }]);
  }
});

test('memory extraction rejects a substituted response model and supports matching or omitted identities', async () => {
  const response = completion(JSON.stringify({ memories: [memory] }));
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    await assert.rejects(provider.extract({ events: [event] }), error => error instanceof ProviderError && error.code === 'provider_model_mismatch');
    assert.equal(requests.length, 2, 'A bounded repair must still reject a substituted model.');
    assert.deepEqual(requests.map(request => request.body.model), ['nvidia/Nemotron-3_5-Lightning', 'nvidia/Nemotron-3_5-Lightning']);
  }, [{ ...response, model: 'synthetic-substituted-memory' }]);
  await withFakeEndpoint(async baseUrl => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await provider.extract({ events: [event] });
      assert.equal(result.model, provider.config.modelId);
      assert.equal(result.memories[0]?.quote, event.text);
    }
  }, [{ ...response, model: 'nvidia/Nemotron-3_5-Lightning' }, response]);
});

test('empty or malformed supplied memory model identities fail before extraction admission', async () => {
  const response = completion(JSON.stringify({ memories: [memory] }));
  for (const model of ['', '   ', ' nvidia/Nemotron-3_5-Lightning', 'nvidia/Nemotron-3_5-Lightning\n', null, 42, { id: 'nvidia/Nemotron-3_5-Lightning' }]) {
    await withFakeEndpoint(async baseUrl => {
      const provider = new OpenAICompatibleProvider(config(baseUrl));
      await assert.rejects(provider.extract({ events: [event] }), error => error instanceof ProviderError && error.code === 'provider_invalid_chat_response');
    }, [{ ...response, model }]);
  }
});

test('agent-reported summaries and assistant suggestions cannot become direct user statements', async () => {
  await withFakeEndpoint(async (baseUrl) => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    const summary = await provider.extract({ events: [{ ...event, author_role: 'assistant', origin: 'agent_reported' }] });
    assert.equal(summary.memories[0]?.origin, 'agent_reported');
    const suggestion = await provider.extract({ events: [{ ...event, author_role: 'assistant', origin: 'assistant_proposed' }] });
    assert.equal(suggestion.memories[0]?.origin, 'assistant_proposed');
  }, [completion(JSON.stringify({ memories: [memory] }))]);
});

test('the extractor cannot manufacture a user confirmation from a user statement', async () => {
  await withFakeEndpoint(async (baseUrl) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(result.memories[0]?.origin, 'user_explicit');
  }, [completion(JSON.stringify({ memories: [{ ...memory, origin: 'user_confirmed' }] }))]);
});

test('inferences supported by agent reports retain inference classification', async () => {
  await withFakeEndpoint(async (baseUrl) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [{ ...event, author_role: 'assistant', origin: 'agent_reported' }] });
    assert.equal(result.memories[0]?.origin, 'inferred');
  }, [completion(JSON.stringify({ memories: [{ ...memory, origin: 'inferred' }] }))]);
});

test('inferred sources keep source-owned attribution for every role and returned origin', async () => {
  for (const author_role of ['user', 'assistant', 'system', 'unknown'] as const) {
    const source: SourceEvent = { ...event, author_role, origin: 'inferred' };
    const original = structuredClone(source);
    for (const origin of ['user_explicit', 'user_confirmed', 'agent_reported', 'assistant_proposed', 'inferred'] as const) {
      await withFakeEndpoint(async (baseUrl, requests) => {
        const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
        assert.deepEqual(result.memories, [{ statement: memory.statement, kind: memory.kind,
          source_event_id: source.id, quote: source.text, origin: 'inferred' }]);
        assert.equal(requests.length, 1, 'Known source attribution needs no extra model request.');
        assert.deepEqual(source, original);
        assert.deepEqual(JSON.parse((requests[0].body.messages as Array<{ content: string }>)[1].content).events, [original]);
      }, [completion(JSON.stringify({ memories: [{ ...memory, origin }] }))]);
    }
  }
});

test('inferred attribution normalization preserves bounded validation and repair', async () => {
  const source: SourceEvent = { ...event, author_role: 'assistant', origin: 'inferred' };
  const promoted = { ...memory, origin: 'agent_reported' };
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
    assert.equal(result.memories[0].origin, 'inferred');
    assert.equal(requests.length, 2);
    assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 });
  }, [completion('invalid JSON'), completion(JSON.stringify({ memories: [promoted] }))]);
  await withFakeEndpoint(async (baseUrl, requests) => {
    await assert.rejects(new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] }),
      error => error instanceof ProviderError && error.code === 'extraction_invalid_evidence');
    assert.equal(requests.length, 2, 'Attribution normalization cannot admit an unsupported quote.');
  }, [completion(JSON.stringify({ memories: [{ ...promoted, quote: 'Unsupported synthetic evidence.' }] }))]);
});

test('truncated or non-JSON thinking output is rejected, bounded repair usage is accumulated', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 2);
    assert.equal(result.memories.length, 1);
    assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 });
  }, [completion('Thinking: the user probably wants some memory.'), completion(JSON.stringify({ memories: [memory] }))]);
});

test('reasoning effort is opt-in, validated and forwarded at top level through bounded repair', async () => {
  assert.equal(providerConfigFromEnv({}).reasoningEffort, undefined);
  assert.equal(providerConfigFromEnv({ MODEL_REASONING_EFFORT: '' }).reasoningEffort, undefined);
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    await withFakeEndpoint(async (baseUrl, requests) => {
      const provider = new OpenAICompatibleProvider({ ...config(baseUrl), ...providerConfigFromEnv({ MODEL_BASE_URL: baseUrl, MODEL_REASONING_EFFORT: effort }) });
      const result = await provider.extract({ events: [event] });
      assert.equal(result.memories.length, 1);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests.map(request => request.body.reasoning_effort), [effort, effort]);
      assert(requests.every(request => request.body.extra_body === undefined));
      assert(requests.every(request => request.body.model === 'nvidia/Nemotron-3_5-Lightning'));
    }, [completion('unusable'), completion(JSON.stringify({ memories: [memory] }))]);
  }
  for (const effort of ['NONE', 'none ', ' none', 'max', 'false', 'synthetic-private-invalid-control']) {
    assert.throws(() => providerConfigFromEnv({ MODEL_REASONING_EFFORT: effort }), error => error instanceof Error
      && error.message.startsWith('MODEL_REASONING_EFFORT must be') && !error.message.includes('synthetic-private-invalid-control'));
  }
  await withFakeEndpoint(async (baseUrl, requests) => {
    await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests[0].body.reasoning_effort, undefined, 'Generic compatible providers receive no reasoning control by default.');
  }, [completion(JSON.stringify({ memories: [memory] }))]);
});

test('an explicit effective timestamp is admitted only with its full supporting exact quote', async () => {
  const timestamp = '2026-11-01T09:00:00Z';
  const timedEvent = { ...event, text: `Starting at ${timestamp}, I prefer weekly status reports on Mondays.` };
  const timedMemory = { ...memory, statement: 'Prefers weekly status reports on Mondays.', effective_at: timestamp };
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [timedEvent] });
    assert.equal(requests.length, 2);
    assert.equal(result.memories[0].effective_at, timestamp);
    assert.equal(result.memories[0].quote, timedEvent.text);
  }, [
    completion(JSON.stringify({ memories: [{ ...timedMemory, quote: 'I prefer weekly status reports on Mondays.' }] })),
    completion(JSON.stringify({ memories: [{ ...timedMemory, quote: timedEvent.text }] })),
  ]);
});

test('date-only or invented effective timestamps require repair instead of admission', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] });
    assert.equal(requests.length, 2);
    assert.equal(result.memories[0]?.effective_at, undefined);
  }, [completion(JSON.stringify({ memories: [{ ...memory, effective_at: '2026-10-20' }] })), completion(JSON.stringify({ memories: [memory] }))]);
  await withFakeEndpoint(async (baseUrl) => {
    await assert.rejects(new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event] }), error => error instanceof ProviderError && error.code === 'extraction_unsupported_effective_timestamp');
  }, [completion(JSON.stringify({ memories: [{ ...memory, effective_at: '2026-10-20T00:00:00Z' }] }))]);
});

test('literal direct-user start qualifiers missing their timestamp receive one repair without automatic assignment', async () => {
  for (const sample of [
    { prefix: 'Starting at', timestamp: '2032-03-04T05:06:07Z', statement: 'I work remotely on Tuesdays.', kind: 'fact' as const, origin: 'user_explicit' as const },
    { prefix: 'Starting from', timestamp: '2035-12-08T09:10:11-03:00', statement: 'I use the west entrance.', kind: 'fact' as const, origin: 'user_explicit' as const },
    { prefix: 'Effective from', timestamp: '2034-06-18T08:30:00.125+02:00', statement: 'I prefer morning briefings.', kind: 'preference' as const, origin: 'user_confirmed' as const },
  ]) {
    const source: SourceEvent = { ...event, origin: sample.origin, text: `${sample.prefix} ${sample.timestamp}, ${sample.statement}` };
    const candidate = { ...memory, statement: sample.statement, kind: sample.kind, origin: sample.origin, quote: source.text };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 2, 'A missing field must cause repair, never silent timestamp assignment.');
      assert.equal(result.memories[0].effective_at, sample.timestamp);
      assert.equal(result.memories[0].origin, sample.origin);
      assert.equal(result.memories[0].quote, source.text);
      assert.equal(result.memories[0].statement, sample.statement);
      assert.equal(requests[1].body.response_format, undefined);
      const repair = (requests[1].body.messages as Array<{ content: string }>).at(-1)!.content;
      assert(repair.includes('extraction_missing_effective_timestamp'));
      assert(!repair.includes(sample.timestamp), 'Repair diagnostics must not copy source content.');
      assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 });
    }, [completion(JSON.stringify({ memories: [candidate] })), completion(JSON.stringify({ memories: [{ ...candidate, effective_at: sample.timestamp }] }))]);
  }
});

test('repeated literal effective-time omissions reject the whole extraction after two attempts', async () => {
  const timestamp = '2033-09-12T14:15:16-04:00';
  const source = { ...event, id: 'timed-source', text: `Effective at ${timestamp}, I use the north office.` };
  const candidate = { ...memory, source_event_id: source.id, statement: '  I use the north office  ', kind: 'fact', quote: source.text };
  const snapshot = structuredClone(source);
  await withFakeEndpoint(async (baseUrl, requests) => {
    await assert.rejects(new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event, source] }), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'extraction_missing_effective_timestamp');
      assert.equal(error.message, 'extraction_missing_effective_timestamp');
      return true;
    });
    assert.equal(requests.length, 2, 'The existing two-attempt limit applies to repeated omission.');
    assert.deepEqual(source, snapshot, 'Source evidence remains unchanged after failed extraction.');
  }, [completion(JSON.stringify({ memories: [memory, candidate] }))]);
});

test('supplied literal effective timestamps and source attribution remain unchanged', async () => {
  for (const prefix of ['Starting from', 'Effective at']) {
    const timestamp = '2031-08-09T10:11:12+05:30';
    const source = { ...event, text: `${prefix} ${timestamp}, I prefer quiet mornings.` };
    const candidate = { ...memory, statement: 'I prefer quiet mornings.', quote: source.text, effective_at: timestamp, origin: 'user_confirmed' };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 1);
      assert.equal(result.memories[0].effective_at, timestamp);
      assert.equal(result.memories[0].origin, 'user_explicit', 'The model cannot turn a source statement into user confirmation.');
    }, [completion(JSON.stringify({ memories: [candidate] }))]);
  }
});

test('literal date-only starts require a repaired statement without inventing effective timestamps', async () => {
  for (const sample of [
    { prefix: 'Starting on', date: '2036-02-29', statement: 'I work remotely on Tuesdays.', origin: 'user_explicit' as const },
    { prefix: 'Effective from', date: 'April 30, 2031', statement: 'I prefer written agendas.', origin: 'user_confirmed' as const },
    { prefix: 'Starting from', date: 'june 9 2034', statement: 'I use the east entrance.', origin: 'user_explicit' as const },
    { prefix: 'Effective on', date: '17 September 2033', statement: 'I prefer quiet mornings.', origin: 'user_explicit' as const },
    { prefix: 'Starting on', date: 'February 29, 2000', statement: 'I use the north office.', origin: 'user_explicit' as const },
  ]) {
    const source: SourceEvent = { ...event, origin: sample.origin, text: `${sample.prefix} ${sample.date}, ${sample.statement}` };
    const candidate = { ...memory, origin: sample.origin, statement: sample.statement, quote: source.text };
    const repaired = { ...candidate, statement: `${sample.statement} This starts on ${sample.date}.` };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 2, sample.date);
      assert.equal(result.memories[0].statement, repaired.statement, 'Admit the model repair without rewriting it.');
      assert.equal(result.memories[0].effective_at, undefined, 'A calendar date cannot supply a timezone.');
      assert.equal(result.memories[0].quote, source.text);
      assert.equal(result.memories[0].origin, sample.origin);
      assert.equal(requests[1].body.response_format, undefined);
      const repair = (requests[1].body.messages as Array<{ content: string }>).at(-1)!.content;
      assert(repair.includes('extraction_missing_effective_date_qualifier'));
      assert(!repair.includes(sample.date), 'Sanitized repair diagnostics must not copy the source date.');
      assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 });
    }, [completion(JSON.stringify({ memories: [candidate] })), completion(JSON.stringify({ memories: [repaired] }))]);
  }
});

test('repeated date-only omission rejects every candidate after the existing two attempts', async () => {
  const source = { ...event, id: 'dated-source', text: 'Starting on October 21, 2037, I use the west entrance.' };
  const candidate = { ...memory, source_event_id: source.id, statement: '  I use the west entrance  ', quote: source.text };
  const snapshot = structuredClone(source);
  await withFakeEndpoint(async (baseUrl, requests) => {
    await assert.rejects(new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [event, source] }), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'extraction_missing_effective_date_qualifier');
      assert.equal(error.message, 'extraction_missing_effective_date_qualifier');
      return true;
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(source, snapshot, 'Failed extraction preserves original source evidence.');
  }, [completion(JSON.stringify({ memories: [memory, candidate] }))]);
});

test('retained date-only qualifiers stay unchanged with null time and source-owned attribution', async () => {
  const source = { ...event, text: 'Starting on March 4, 2032, I prefer morning briefings.' };
  for (const statement of [source.text, 'I prefer morning briefings starting on March 4, 2032.', 'I prefer morning briefings. The preference starts on March 4, 2032.']) {
    const candidate = { ...memory, statement, quote: source.text, origin: 'user_confirmed' };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 1);
      assert.equal(result.memories[0].statement, statement);
      assert.equal(result.memories[0].effective_at, undefined);
      assert.equal(result.memories[0].origin, 'user_explicit', 'The model cannot invent confirmation.');
    }, [completion(JSON.stringify({ memories: [candidate] }))]);
  }
});

test('date-only guard skips invalid calendars, incomplete dates and ambiguous source associations', async () => {
  const statement = 'I prefer morning briefings.';
  const qualified = `Starting on March 4, 2032, ${statement}`;
  const cases: Array<{ name: string; text: string; statement: string; quote?: string; source?: Partial<SourceEvent>; origin?: ExplicitMemory['origin'] }> = [
    ...['2031-02-29', '2100-02-29', '2032-02-30', '2032-00-04', '2032-13-04', '2032-03-00', 'April 31, 2032', 'February 29, 1900', '31 June 2032', 'March 0, 2032', 'March 4', '03/04/2032'].map(date => ({ name: date, text: `Starting on ${date}, ${statement}`, statement })),
    { name: 'paraphrase', text: qualified, statement: 'Prefers morning briefings.' },
    { name: 'partial quote', text: qualified, quote: statement, statement },
    { name: 'hidden negative context', text: `Do not use this example: ${qualified}`, quote: qualified, statement },
    { name: 'hypothetical context', text: `If approved: ${qualified}`, quote: qualified, statement },
    { name: 'compound assertion', text: `${qualified} I work remotely.`, statement: `${statement} I work remotely.` },
    { name: 'conjunction', text: 'Starting on March 4, 2032, I prefer morning briefings and written agendas.', statement: 'I prefer morning briefings and written agendas.' },
    { name: 'negation', text: 'Starting on March 4, 2032, I do not prefer morning briefings.', statement: 'I do not prefer morning briefings.' },
    { name: 'modal', text: 'Starting on March 4, 2032, I might prefer morning briefings.', statement: 'I might prefer morning briefings.' },
    { name: 'deadline', text: 'The review is due on March 4, 2032.', statement: 'The review is due on March 4, 2032.' },
    { name: 'qualified deadline', text: 'Starting on March 4, 2032, The review deadline is Friday.', statement: 'The review deadline is Friday.' },
    { name: 'multiple calendar dates', text: 'Starting on March 4, 2032, I use the 2033-06-07 release.', statement: 'I use the 2033-06-07 release.' },
    { name: 'multiline', text: `Starting on March 4, 2032,\n${statement}`, statement },
    { name: 'assistant source', text: qualified, statement, source: { author_role: 'assistant', origin: 'assistant_proposed' } },
    { name: 'agent source', text: qualified, statement, source: { author_role: 'assistant', origin: 'agent_reported' } },
    { name: 'inferred source', text: qualified, statement, source: { origin: 'inferred' } },
    { name: 'inferred interpretation', text: qualified, statement, origin: 'inferred' },
  ];
  for (const sample of cases) {
    const source: SourceEvent = { ...event, ...sample.source, text: sample.text };
    const candidate = { ...memory, statement: sample.statement, quote: sample.quote ?? source.text, origin: sample.origin ?? 'user_explicit' };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 1, sample.name);
      assert.equal(result.memories[0].effective_at, undefined, sample.name);
      assert.equal(result.memories[0].statement, sample.statement, sample.name);
      assert.equal(result.memories[0].quote, candidate.quote, sample.name);
    }, [completion(JSON.stringify({ memories: [candidate] }))]);
  }
});

test('literal effective-time validation skips ambiguous associations and preserves unknown dates', async () => {
  const timestamp = '2032-03-04T05:06:07Z';
  const statement = 'I prefer morning briefings.';
  const qualified = `Starting at ${timestamp}, ${statement}`;
  const cases: Array<{ name: string; text: string; statement: string; quote?: string; source?: Partial<SourceEvent>; origin?: ExplicitMemory['origin'] }> = [
    { name: 'paraphrase', text: qualified, statement: 'Prefers morning briefings.' },
    { name: 'interior whitespace difference', text: qualified.replace('morning briefings', 'morning  briefings'), statement },
    { name: 'retained statement qualifier', text: qualified, statement: qualified },
    { name: 'hidden negative example context', text: `Do not use this example: ${qualified}`, quote: qualified, statement },
    { name: 'hidden hypothetical context', text: `If approved, the draft says: ${qualified}`, quote: qualified, statement },
    { name: 'timezone omitted', text: `Starting at 2032-03-04T05:06:07, ${statement}`, statement },
    { name: 'invalid calendar date', text: `Starting at 2032-02-31T05:06:07Z, ${statement}`, statement },
    { name: 'deadline', text: `The review is due at ${timestamp}.`, statement: `The review is due at ${timestamp}.` },
    { name: 'qualified deadline', text: `Starting at ${timestamp}, The review deadline is Friday.`, statement: 'The review deadline is Friday.' },
    { name: 'unrelated compound assertion', text: `${qualified} The review deadline is Friday.`, statement: 'The review deadline is Friday.' },
    { name: 'multiple sentences', text: `${qualified} I work remotely.`, statement: `${statement} I work remotely.` },
    { name: 'conjoined assertions', text: `Starting at ${timestamp}, I prefer morning briefings and I work remotely.`, statement: 'I prefer morning briefings and I work remotely.' },
    { name: 'semicolon', text: `Starting at ${timestamp}, I prefer morning briefings; I work remotely.`, statement: 'I prefer morning briefings; I work remotely.' },
    { name: 'conditional', text: `Starting at ${timestamp}, if approved I prefer morning briefings.`, statement: 'if approved I prefer morning briefings.' },
    { name: 'negation', text: `Starting at ${timestamp}, I do not prefer morning briefings.`, statement: 'I do not prefer morning briefings.' },
    { name: 'modal', text: `Starting at ${timestamp}, I might prefer morning briefings.`, statement: 'I might prefer morning briefings.' },
    { name: 'tentative permission', text: `Starting at ${timestamp}, I may prefer morning briefings.`, statement: 'I may prefer morning briefings.' },
    { name: 'quoted assertion', text: `Starting at ${timestamp}, \`I prefer morning briefings.\``, statement: '`I prefer morning briefings.`' },
    { name: 'multiple timestamps', text: `Starting at ${timestamp}, I prefer briefings until 2033-03-04T05:06:07Z.`, statement: 'I prefer briefings until 2033-03-04T05:06:07Z.' },
    { name: 'multiline', text: `Starting at ${timestamp},\n${statement}`, statement },
    { name: 'assistant source', text: qualified, statement, source: { author_role: 'assistant', origin: 'assistant_proposed' } },
    { name: 'agent report', text: qualified, statement, source: { author_role: 'assistant', origin: 'agent_reported' } },
    { name: 'inferred interpretation', text: qualified, statement, origin: 'inferred' },
  ];
  for (const sample of cases) {
    const source: SourceEvent = { ...event, ...sample.source, text: sample.text };
    const candidate = { ...memory, statement: sample.statement, quote: sample.quote ?? source.text, origin: sample.origin ?? 'user_explicit' };
    await withFakeEndpoint(async (baseUrl, requests) => {
      const result = await new OpenAICompatibleProvider(config(baseUrl)).extract({ events: [source] });
      assert.equal(requests.length, 1, sample.name);
      assert.equal(result.memories[0].effective_at, undefined, sample.name);
      assert.equal(result.memories[0].statement, sample.statement, sample.name);
      assert.equal(result.memories[0].quote, candidate.quote, sample.name);
    }, [completion(JSON.stringify({ memories: [candidate] }))]);
  }
});

test('embedding vectors are validated, ordered by response indices, and dimension changes fail', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'local-embedding-alias', timeoutMs: 1000 });
    const result = await provider.embed(['one', 'two']);
    assert.equal(result.dimensions, 3);
    assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
    assert.equal(requests[0]?.body.dimensions, undefined, 'probe may measure the natural dimension');
    await assert.rejects(provider.embed(['next']), error => error instanceof ProviderError && error.code === 'embedding_dimension_mismatch');
  }, [{ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] }, { data: [{ index: 0, embedding: [1, 0] }] }]);
});

test('same-dimensional embeddings from another model are rejected while matching or omitted identities remain supported', async () => {
  const data = [{ index: 0, embedding: [1, 0] }];
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'synthetic-selected', dimensions: 2, timeoutMs: 1000 });
    await assert.rejects(provider.embed(['synthetic context']), error => error instanceof ProviderError && error.code === 'embedding_model_mismatch');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await provider.embed(['synthetic context']);
      assert.equal(result.model, 'synthetic-selected');
      assert.deepEqual(result.vectors, [[1, 0]]);
    }
    assert.deepEqual(requests.map(request => request.body.model), ['synthetic-selected', 'synthetic-selected', 'synthetic-selected']);
  }, [{ model: 'synthetic-substituted', data }, { model: 'synthetic-selected', data }, { data }]);
});

test('empty or malformed supplied embedding model identities are invalid responses', async () => {
  for (const model of ['', '   ', ' synthetic-selected', 'synthetic-selected\n', null, 42, { id: 'synthetic-selected' }]) {
    await withFakeEndpoint(async baseUrl => {
      const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'synthetic-selected', dimensions: 2, timeoutMs: 1000 });
      await assert.rejects(provider.embed(['synthetic context']), error => error instanceof ProviderError && error.code === 'embedding_invalid_response');
    }, [{ model, data: [{ index: 0, embedding: [1, 0] }] }]);
  }
});

test('optional runtime embeddings require explicit pgvector dimensions without choosing a model', () => {
  assert.equal(createEmbeddingProvider({}), undefined);
  assert.equal(createEmbeddingProvider({ EMBEDDING_DIMENSIONS: '3' }), undefined);
  assert.throws(() => createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-embedding' }), /EMBEDDING_DIMENSIONS is required/);
  for (const dimensions of ['0', '-1', '1.5', 'NaN', '16001']) {
    assert.throws(() => createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-embedding', EMBEDDING_DIMENSIONS: dimensions }));
  }
  const provider = createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-4096', EMBEDDING_DIMENSIONS: '4096' });
  assert.equal(provider?.config.dimensions, 4096, 'storage-compatible dimensions are not restricted to ANN index limits');
  assert.equal(provider?.config.modelId, 'synthetic-4096');
  assert.equal(createEmbeddingProvider({ EMBEDDING_MODEL: 'synthetic-16000', EMBEDDING_DIMENSIONS: '16000' })?.config.dimensions, 16000);
});

test('self-hosted embeddings send the configured dimension and never inherit a distinct endpoint key', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const provider = createEmbeddingProvider({
      MODEL_BASE_URL: 'https://models.example.invalid/v1/', MODEL_API_KEY: 'synthetic-model-key', NEBIUS_API_KEY: 'synthetic-nebius-key',
      EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: 'self-hosted-reduced', EMBEDDING_DIMENSIONS: '3',
    });
    const result = await provider!.embed(['synthetic portable context']);
    assert.equal(requests[0]?.path, '/v1/embeddings');
    assert.equal(requests[0]?.authorization, undefined);
    assert.deepEqual(requests[0]?.body, {
      model: 'self-hosted-reduced', input: ['synthetic portable context'], encoding_format: 'float', dimensions: 3,
    });
    assert.deepEqual(result.vectors, [[Math.fround(0.1), 0, 1]]);
  }, [{ data: [{ index: 0, embedding: [0.1, 0, 1] }] }]);
});

test('embedding-specific credentials override shared endpoint credentials', async () => {
  await withFakeEndpoint(async (baseUrl, requests) => {
    const env = { MODEL_BASE_URL: baseUrl, MODEL_API_KEY: 'synthetic-model-key', EMBEDDING_MODEL: 'local-alias', EMBEDDING_DIMENSIONS: '2' };
    await createEmbeddingProvider(env)!.embed(['synthetic one']);
    await createEmbeddingProvider({ ...env, EMBEDDING_API_KEY: 'synthetic-embedding-key' })!.embed(['synthetic two']);
    assert.equal(requests[0]?.authorization, 'Bearer synthetic-model-key');
    assert.equal(requests[1]?.authorization, 'Bearer synthetic-embedding-key');
  }, [{ data: [{ index: 0, embedding: [1, 0] }] }]);
});

test('valid high-dimensional batches are not restricted by the chat response size cap', async () => {
  const dimensions = 16_000;
  const data = Array.from({ length: 8 }, (_, index) => ({ index, embedding: Array.from({ length: dimensions }, () => 0.12345678901234567) }));
  assert.ok(JSON.stringify({ data }).length > 2_000_000);
  await withFakeEndpoint(async baseUrl => {
    const provider = createEmbeddingProvider({ EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: 'synthetic-large', EMBEDDING_DIMENSIONS: String(dimensions) });
    const result = await provider!.embed(data.map(({ index }) => `synthetic memory ${index}`));
    assert.equal(result.vectors.length, data.length);
    assert.equal(result.dimensions, dimensions);
  }, [{ data }]);
});

test('zero, non-float32, malformed, and mismatched embedding responses are rejected', async () => {
  const fixtures: { reply: unknown; code: string }[] = [
    { reply: { data: [{ index: 0, embedding: [0, 0] }] }, code: 'embedding_zero_vector' },
    { reply: { data: [{ index: 0, embedding: [1e100, 1] }] }, code: 'embedding_invalid_component' },
    { reply: { data: [{ index: 0, embedding: [1e-100, 1] }] }, code: 'embedding_invalid_component' },
    { reply: { data: [{ index: 0, embedding: [null, 1] }] }, code: 'embedding_invalid_response' },
    { reply: { data: [{ index: 0, embedding: ['1', 1] }] }, code: 'embedding_invalid_response' },
    { reply: { data: [] }, code: 'embedding_invalid_response' },
    { reply: { data: [{ index: 1, embedding: [1, 0] }] }, code: 'embedding_invalid_indices' },
    { reply: { data: [{ index: 0, embedding: [1, 0, 0] }] }, code: 'embedding_dimension_mismatch' },
  ];
  for (const { reply, code } of fixtures) {
    await withFakeEndpoint(async baseUrl => {
      const provider = createEmbeddingProvider({ EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: 'synthetic', EMBEDDING_DIMENSIONS: '2' });
      await assert.rejects(provider!.embed(['synthetic vector validation']), error => error instanceof ProviderError && error.code === code);
    }, [reply]);
  }
  await withFakeEndpoint(async baseUrl => {
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, modelId: 'synthetic', timeoutMs: 1000 });
    await assert.rejects(provider.embed(['synthetic one', 'synthetic two']), error => error instanceof ProviderError && error.code === 'embedding_invalid_indices');
  }, [{ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] }]);
});

test('embedding configuration is optional and does not send model key to a different endpoint', () => {
  assert.equal(embeddingConfigFromEnv({}), null);
  const distinct = embeddingConfigFromEnv({ MODEL_BASE_URL: 'https://one.example/v1/', MODEL_API_KEY: 'synthetic-secret', EMBEDDING_BASE_URL: 'http://localhost:8080/v1/', EMBEDDING_MODEL: 'local-embedding-alias' });
  assert.equal(distinct?.apiKey, undefined);
  assert.equal(providerConfigFromEnv({ MODEL_BASE_URL: 'http://localhost:8000/v1/', NEBIUS_API_KEY: 'synthetic-secret' }).apiKey, undefined);
  assert.throws(() => providerConfigFromEnv({ MODEL_BASE_URL: 'https://user:pass@example.com/v1/' }));
  assert.throws(() => providerConfigFromEnv({ MODEL_BASE_URL: 'synthetic-secret-invalid-url' }), error => error instanceof Error && !error.message.includes('synthetic-secret'));
});
