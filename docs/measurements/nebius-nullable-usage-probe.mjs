import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const model = 'nvidia/Nemotron-3_5-Lightning';
const counts = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'];
const details = ['cached_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];

// Preserve numeric/null diagnostic shape without retaining provider text or arbitrary keys.
function shape(value, keys) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: typeof value };
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => {
    const item = value[key];
    return [key, item === null || typeof item === 'number' ? item : { type: typeof item }];
  }));
}

async function main() {
  assert(process.argv.length === 3 && process.argv[2], 'destination required');
  assert(process.env.NEBIUS_API_KEY, 'credential missing');
  const output = resolve(process.argv[2]);
  // Exclusive creation rejects existing files/symlinks and missing parents before inference.
  const file = await open(output, 'wx+', 0o600);
  const identity = await file.stat();
  const cancellation = new AbortController();
  const interrupt = () => { process.exitCode = 1; cancellation.abort(); };
  const ownsPath = async () => {
    try {
      const current = await lstat(output);
      return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  let complete = false;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    cancellation.signal.throwIfAborted();
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply exactly READY.' }],
      temperature: 0, max_tokens: 32, reasoning_effort: 'none' });
    const started = Date.now();
    const response = await fetch('https://api.tokenfactory.nebius.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(60_000)]),
    });
    const raw = await response.text();
    assert(response.ok, 'provider request failed');
    const parsed = JSON.parse(raw);
    const usage = shape(parsed.usage, counts);
    if (usage && parsed.usage && typeof parsed.usage === 'object') {
      for (const key of ['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details']) {
        if (Object.hasOwn(parsed.usage, key)) usage[key] = shape(parsed.usage[key], details);
      }
    }
    const result = { purpose: 'Diagnose nullable usage detail schema after rejected native run',
      measured_at: new Date(started).toISOString(), http_status: response.status, requested_model: model,
      returned_model_matches: parsed.model === model, reasoning_effort: 'none', elapsed_ms: Date.now() - started,
      request_sha256: createHash('sha256').update(body).digest('hex'),
      response_sha256: createHash('sha256').update(raw).digest('hex'), usage };
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    cancellation.signal.throwIfAborted();
    assert(await ownsPath(), 'reserved path replaced');
    await file.truncate(0);
    await file.writeFile(bytes);
    await file.sync();
    const actual = Buffer.alloc(bytes.length);
    const read = await file.read(actual, 0, bytes.length, 0);
    assert(read.bytesRead === bytes.length && actual.equals(bytes), 'evidence bytes changed');
    assert((await file.stat()).size === bytes.length && await ownsPath(), 'reserved path changed');
    cancellation.signal.throwIfAborted();
    complete = true;
  } finally {
    try {
      await file.close();
    } finally {
      if (!complete || cancellation.signal.aborted) {
        if (await ownsPath()) await unlink(output);
      }
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    }
  }
}

try { await main(); }
catch {
  process.exitCode = 1;
  console.error('FAIL: nullable usage diagnostic did not complete. Supply a fresh writable output path and configured credentials.');
}
