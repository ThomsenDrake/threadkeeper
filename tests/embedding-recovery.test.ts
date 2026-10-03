import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { createStore, type Auth } from '../packages/core/src/index.ts';
import { createTestDatabase } from './helpers.ts';
import { syntheticEmbeddings } from './hybrid-fixtures.ts';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => { fixture = await createTestDatabase({ vector: true }); });
afterEach(async () => { await fixture.db.query('TRUNCATE tk_owners CASCADE'); });
after(async () => { await fixture.close(); });

const owner = (): Auth => ({ ownerId: randomUUID(), clientId: 'profile', permissions: ['*'], projects: null });
async function capture(auth: Auth, statement: string) {
  const event = randomUUID();
  return createStore(fixture.db).capture(auth, {
    idempotency_key: randomUUID(), project_id: 'synthetic-recovery',
    events: [{ id: event, text: statement, author_role: 'user', origin: 'user_explicit' }],
    explicit_memories: [{ statement, quote: statement, kind: 'fact', origin: 'user_explicit', source_event_id: event }],
  });
}
async function attempts() {
  return (await fixture.db.query(`SELECT memory_id,revision,space_id,attempts,claim_token,lease_until,
    EXTRACT(EPOCH FROM (next_attempt_at-now()))*1000 AS delay_ms
    FROM tk_embedding_attempts ORDER BY next_attempt_at,memory_id`)).rows;
}
async function due() {
  await fixture.db.query("UPDATE tk_embedding_attempts SET next_attempt_at=now()-interval '1 second'");
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('a rejected input cannot starve fresh memories or healthy peers from its failed batch', async () => {
  const auth = owner();
  const poison = 'Synthetic poison input rejected by the configured endpoint.';
  const healthy = 'Synthetic writing preference is compact paragraphs.';
  const fresh = 'Synthetic project deadline is October 25.';
  const embeddings = syntheticEmbeddings();
  embeddings.beforeEmbed = async () => {
    if (embeddings.calls.at(-1)!.includes(poison)) throw new Error('Synthetic opaque input rejection');
  };
  const store = createStore(fixture.db, { embeddings });
  await capture(auth, poison);
  await capture(auth, healthy);
  const rejected = await store.processEmbeddings(2);
  assert.equal(rejected.status, 'provider_failed');
  assert.equal(rejected.pending, 2);
  assert.equal(rejected.deferred, 2);
  assert.equal(embeddings.calls.length, 1);

  await capture(auth, fresh);
  const progressed = await store.processEmbeddings(2);
  assert.equal(progressed.indexed, 1);
  assert.equal(progressed.pending, 2);
  assert.deepEqual(embeddings.calls[1], [fresh]);
  await due();
  // Whichever member wins the stable due-time/ID ordering, both retries are
  // singleton requests. A second poison failure cannot defer its healthy peer.
  const retryA = await store.processEmbeddings(2);
  const retryB = await store.processEmbeddings(2);
  assert.equal(retryA.indexed + retryB.indexed, 1);
  assert.deepEqual(embeddings.calls.slice(2).map(rows => rows.length), [1, 1]);
  const remaining = await attempts();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attempts, 2);
  assert(remaining[0].delay_ms > 59_000 && remaining[0].delay_ms <= 60_000);
  const recalled = await store.search(auth, { query: 'nonlexical synthetic context' });
  assert.deepEqual(recalled.memories.map(row => row.statement).sort(), [healthy, fresh].sort());
});

test('provider outages make one bounded request and retain exponential cooldown across worker restart', async () => {
  const auth = owner();
  const embeddings = syntheticEmbeddings();
  embeddings.fail = true;
  await capture(auth, 'Synthetic recoverable preference one.');
  await capture(auth, 'Synthetic recoverable preference two.');
  const first = await createStore(fixture.db, { embeddings }).processEmbeddings();
  assert.equal(first.status, 'provider_failed');
  assert.equal(embeddings.calls.length, 1);
  assert.equal(first.deferred, 2);
  assert(first.retry_after_ms! > 29_000 && first.retry_after_ms! <= 30_000);
  const restarted = createStore(fixture.db, { embeddings });
  const waiting = await restarted.processEmbeddings();
  assert.equal(waiting.status, 'deferred');
  assert.equal(waiting.pending, 2);
  assert.equal(embeddings.calls.length, 1, 'A restart must not reset durable backoff.');
  const rows = await attempts();
  assert(rows.every(row => row.attempts === 1 && row.claim_token === null && row.lease_until === null));
  await due();
  const retry = await restarted.processEmbeddings();
  assert.equal(retry.status, 'provider_failed');
  assert.equal(embeddings.calls.length, 2);
  assert.equal(embeddings.calls[1].length, 1);
  assert((await attempts()).some(row => row.attempts === 2 && row.delay_ms > 59_000));
  await fixture.db.query('UPDATE tk_embedding_attempts SET attempts=31');
  await due();
  await restarted.processEmbeddings();
  const maximum = (await attempts()).find(row => row.delay_ms > 3_500_000);
  assert.equal(maximum?.attempts, 31);
  assert(maximum.delay_ms <= 3_600_000);
});

test('active claims prevent duplicate requests and reclaimed tokens fence late worker output', async () => {
  const auth = owner();
  const text = 'Synthetic lease preference.';
  const first = syntheticEmbeddings({ [text]: [1, 0, 0, 0] });
  const replacement = syntheticEmbeddings({ [text]: [0, 1, 0, 0] });
  const started = gate();
  const release = gate();
  first.beforeEmbed = async () => { started.resolve(); await release.promise; };
  await capture(auth, text);
  const original = createStore(fixture.db, { embeddings: first }).processEmbeddings();
  await started.promise;
  try {
    const secondWorker = createStore(fixture.db, { embeddings: replacement });
    const waiting = await secondWorker.processEmbeddings();
    assert.equal(waiting.status, 'deferred');
    assert.equal(waiting.pending, 1);
    assert.equal(replacement.calls.length, 0);
    assert(waiting.retry_after_ms! > 590_000 && waiting.retry_after_ms! <= 600_000);
    await fixture.db.query("UPDATE tk_embedding_attempts SET lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second'");
    assert.equal((await secondWorker.processEmbeddings()).indexed, 1);
  } finally { release.resolve(); }
  const late = await original;
  assert.equal(late.indexed, 0);
  assert.equal(late.skipped, 1);
  assert.equal(late.pending, 0);
  assert.deepEqual(await attempts(), []);
  assert.equal((await fixture.db.query('SELECT embedding::text AS vector FROM tk_embeddings')).rows[0].vector, '[0,1,0,0]');
});

test('expired claims cannot admit vectors even before another worker reclaims them', async () => {
  const auth = owner();
  const embeddings = syntheticEmbeddings();
  const started = gate();
  const release = gate();
  embeddings.beforeEmbed = async () => { started.resolve(); await release.promise; };
  await capture(auth, 'Synthetic expired lease record.');
  const store = createStore(fixture.db, { embeddings });
  const held = store.processEmbeddings();
  await started.promise;
  try {
    await fixture.db.query("UPDATE tk_embedding_attempts SET lease_until=now()-interval '1 second'");
  } finally { release.resolve(); }
  const expired = await held;
  assert.equal(expired.indexed, 0);
  assert.equal(expired.pending, 1);
  assert.equal(expired.deferred, 0);
  assert.equal(expired.retry_after_ms, 0);
  assert.equal(Number((await fixture.db.query('SELECT count(*) AS count FROM tk_embeddings')).rows[0].count), 0);
  embeddings.beforeEmbed = undefined;
  assert.equal((await store.processEmbeddings()).indexed, 1);
});

test('corrections and vector-space changes reset cooldown without admitting obsolete in-flight vectors', async () => {
  const auth = owner();
  const embeddings = syntheticEmbeddings();
  embeddings.fail = true;
  const original = 'Synthetic deadline is October 20.';
  const corrected = 'Synthetic deadline is October 27.';
  const receipt = await capture(auth, original);
  const store = createStore(fixture.db, { embeddings });
  await store.processEmbeddings();
  assert.equal((await attempts()).length, 1);
  await store.correct(auth, receipt.memory_ids[0], { expected_revision: 1, statement: corrected });
  assert.deepEqual(await attempts(), []);
  embeddings.fail = false;
  assert.equal((await store.processEmbeddings()).indexed, 1);
  assert.deepEqual(embeddings.calls.at(-1), [corrected]);
  const secondText = 'Synthetic separate style preference.';
  embeddings.fail = true;
  await capture(auth, secondText);
  await store.processEmbeddings();
  const otherSpace = syntheticEmbeddings({}, { modelId: 'synthetic-new-vector-space' });
  assert.equal((await createStore(fixture.db, { embeddings: otherSpace }).processEmbeddings()).indexed, 2);
  assert.deepEqual(await attempts(), []);

  const started = gate();
  const release = gate();
  otherSpace.beforeEmbed = async () => { started.resolve(); await release.promise; };
  await fixture.db.query('DELETE FROM tk_embeddings WHERE memory_id=$1', [receipt.memory_ids[0]]);
  const currentStore = createStore(fixture.db, { embeddings: otherSpace });
  const held = currentStore.processEmbeddings();
  await started.promise;
  try {
    await currentStore.correct(auth, receipt.memory_ids[0], { expected_revision: 2, statement: 'Synthetic deadline is November 2.' });
  } finally { release.resolve(); }
  assert.equal((await held).indexed, 0);
  assert.deepEqual(await attempts(), []);
  otherSpace.beforeEmbed = undefined;
  assert.equal((await currentStore.processEmbeddings()).indexed, 1);
  assert.equal((await fixture.db.query('SELECT revision FROM tk_embeddings WHERE memory_id=$1', [receipt.memory_ids[0]])).rows[0].revision, 3);
});

test('deletion removes claimed retry state and late provider failures cannot recreate it', async () => {
  const auth = owner();
  const embeddings = syntheticEmbeddings();
  const receipt = await capture(auth, 'Synthetic forgotten retry input.');
  const store = createStore(fixture.db, { embeddings });
  const started = gate();
  const release = gate();
  embeddings.beforeEmbed = async () => { started.resolve(); await release.promise; };
  embeddings.fail = true;
  const held = store.processEmbeddings();
  await started.promise;
  try {
    const preview = await store.previewRemoval(auth, receipt.memory_ids[0]);
    await store.remove(auth, receipt.memory_ids[0], { expected_revision: 1, preview_hash: preview.preview_hash });
    assert.deepEqual(await attempts(), []);
  } finally { release.resolve(); }
  const forgotten = await held;
  assert.equal(forgotten.pending, 0);
  assert.deepEqual(await attempts(), []);
  assert.equal((await store.processEmbeddings()).status, 'idle');
});
