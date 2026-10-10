import { randomUUID } from 'node:crypto';
import { createStore, type Database, type Auth, type EmbeddingProvider } from '../packages/core/src/index.ts';
import { connectedDeletionRecords, applyDeletionRecords } from '../packages/core/src/deletion.ts';
import { bootstrap, createAuth } from '../apps/api/src/auth.ts';
import { seedLegacyDismissal } from './helpers.ts';
import { exportDeletionLedger } from '../packages/core/src/recovery.ts';

const vectors: EmbeddingProvider = { config: { baseUrl: 'http://synthetic.invalid/v1', modelId: 'synthetic-recovery-vectors', dimensions: 3 },
  embed: async texts => ({ vectors: texts.map(() => [1, 0, 0]), dimensions: 3, model: 'synthetic-recovery-vectors' }) };

export async function seedRecoveryFixture(db: Database) {
  await bootstrap(db, 'recovery@example.invalid', 'synthetic-old-password');
  const ownerId = (await db.query('SELECT id FROM tk_users')).rows[0].id;
  const profile: Auth = { ownerId, clientId: 'profile', permissions: ['*'], projects: null };
  const other: Auth = { ...profile, ownerId: randomUUID() };
  const store = createStore(db, { embeddings: vectors });
  async function explicit(auth: Auth, text: string, statements = [text], project_id = 'synthetic-river') {
    const event = randomUUID();
    return store.capture(auth, { idempotency_key: randomUUID(), project_id, subject: 'self',
      events: [{ id: event, text, author_role: 'user', origin: 'user_explicit' }],
      explicit_memories: statements.map(statement => ({ statement, quote: statement, source_event_id: event, kind: 'fact', origin: 'user_explicit', subject: 'self' })) });
  }
  const original = 'Synthetic river deadline is Friday.';
  const sibling = 'Synthetic river notes are short.';
  const corrected = await explicit(profile, `${original} ${sibling}`, [original, sibling]);
  await store.correct(profile, corrected.memory_ids[0], { expected_revision: 1, statement: 'Synthetic river deadline is Monday.' });
  async function candidate(text: string, action: 'confirm' | 'dismiss') {
    const event = randomUUID();
    const captured = await store.capture(profile, { idempotency_key: randomUUID(), project_id: 'synthetic-river', subject: 'self',
      events: [{ id: event, text, author_role: 'user', origin: 'user_explicit' }] });
    await store.processJob({ extract: async () => ({ model: 'synthetic-recovery-model', memories: [{ statement: text, quote: text, source_event_id: event, kind: 'preference', origin: 'inferred' }] }) });
    const memoryId = (await store.captureStatus(profile, captured.capture_id)).memory_ids[0];
    if (action === 'confirm') await store.correct(profile, memoryId, { expected_revision: 1, statement: 'Synthetic owner corrects river notes to use detail.' });
    else await seedLegacyDismissal(db, ownerId, memoryId);
    return memoryId;
  }
  const confirmed = await candidate('Synthetic river notes might be concise.', 'confirm');
  const dismissed = await candidate('Synthetic river summaries might use a checklist.', 'dismiss');
  const survivor = await explicit(profile, 'Synthetic surviving river fact stays available.');
  const unrelated = await explicit(other, `${original} ${sibling}`, [original, sibling]);
  const duplicate = await store.capture({ ...profile, clientId: 'synthetic-duplicate-client' }, { idempotency_key: randomUUID(), project_id: 'another-project', subject: 'self',
    events: [{ id: randomUUID(), text: `  ${original.toUpperCase()}\n ${sibling.toUpperCase()}  `, author_role: 'user', origin: 'user_explicit' }] });
  await db.query("UPDATE tk_jobs SET status='processing',attempts=1,started_at=now() WHERE id=$1", [duplicate.job_id]);
  await store.processEmbeddings(64);
  const auth = createAuth(db);
  const grant = await auth.createClient(ownerId, 'Synthetic restored client', ['read', 'capture'], null);
  const session = await auth.login('recovery@example.invalid', 'synthetic-old-password');
  return { store, profile, other, corrected, confirmed, dismissed, survivor, unrelated, duplicate, grant, session,
    async newerLedgers() {
      await db.transaction(async tx => {
        await tx.query('SELECT id FROM tk_owners WHERE id=$1 FOR UPDATE', [ownerId]);
        const graph = await connectedDeletionRecords(tx, ownerId, { memory_ids: [corrected.memory_ids[0], confirmed, dismissed], source_ids: [] });
        await applyDeletionRecords(tx, ownerId, graph);
        await tx.query('UPDATE tk_owners SET snapshot_version=snapshot_version+1 WHERE id=$1', [ownerId]);
      });
      return Promise.all([exportDeletionLedger(db, profile), exportDeletionLedger(db, other)]);
    } };
}
