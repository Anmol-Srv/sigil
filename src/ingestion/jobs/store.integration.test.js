import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';
import createJobs from '../../db/migrations/20260814120000_create-ingestion-job.cjs';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  getJob,
  pruneFinishedJobs,
  recoverExpiredJobs,
} from './store.js';

let pg;
let db;

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (row) => {
  if (!row || typeof row !== 'object' || row instanceof Date) return row;
  if (Array.isArray(row)) return row.map(camel);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    wrapIdentifier: (value, orig) => orig(snake(value)),
    postProcessResponse: (result) => camel(result),
  });
  db.client._injectedPglite = pg;
  await db.schema.createTable('document', (t) => {
    t.increments('id').primary();
    t.text('uid').notNullable().unique();
  });
  await createJobs.up(db);
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

describe('durable ingestion jobs', () => {
  it('leases staged bytes and clears them only after completion', async () => {
    const queued = await enqueueJob({
      kind: 'document-ingest',
      namespace: 'test',
      payload: { content: 'durable source bytes' },
    }, db);
    expect(queued.created).toBe(true);

    const claimed = await claimNextJob({ workerId: 'worker-1' }, db);
    expect(claimed).toMatchObject({ uid: queued.job.uid, status: 'running', attempts: 1, leaseOwner: 'worker-1' });
    expect(claimed.payload.content).toBe('durable source bytes');

    await completeJob(claimed.uid, { documentUid: 'doc-1' }, db);
    const completed = await getJob(claimed.uid, db);
    expect(completed).toMatchObject({ status: 'completed', stage: 'completed', result: { documentUid: 'doc-1' }, payload: {} });
  });

  it('recovers an expired running lease after interruption', async () => {
    const queued = await enqueueJob({ kind: 'entity-enrichment', payload: { documentId: 1 } }, db);
    const claimed = await claimNextJob({ workerId: 'dead-worker', leaseMs: -1 }, db);
    expect(claimed.uid).toBe(queued.job.uid);

    expect(await recoverExpiredJobs(db)).toBe(1);
    const recovered = await getJob(claimed.uid, db);
    expect(recovered).toMatchObject({ status: 'queued', stage: 'recovered', leaseOwner: null });
    const reclaimed = await claimNextJob({ workerId: 'worker-2' }, db);
    await completeJob(reclaimed.uid, {}, db);
  });

  it('coalesces active maintenance jobs by dedupe key', async () => {
    const first = await enqueueJob({ kind: 'relation-maintenance', dedupeKey: 'relations:test' }, db);
    const second = await enqueueJob({ kind: 'relation-maintenance', dedupeKey: 'relations:test' }, db);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.uid).toBe(first.job.uid);
    const claimed = await claimNextJob({ workerId: 'relation-worker' }, db);
    const duringRun = await enqueueJob({ kind: 'relation-maintenance', dedupeKey: 'relations:test' }, db);
    expect(duringRun.created).toBe(false);
    expect((await getJob(claimed.uid, db)).payload.rerunRequested).toBe(true);
    await completeJob(claimed.uid, {}, db);
  });

  it('prevents a stale lease owner from mutating a reclaimed job', async () => {
    const queued = await enqueueJob({ kind: 'document-ingest', payload: { content: 'lease guarded' } }, db);
    const first = await claimNextJob({ workerId: 'stale-worker', leaseMs: -1 }, db);
    await recoverExpiredJobs(db);
    const second = await claimNextJob({ workerId: 'current-worker' }, db);
    expect(second.uid).toBe(queued.job.uid);

    expect(await completeJob(first.uid, {}, db, 'stale-worker')).toBe(0);
    expect((await getJob(first.uid, db)).leaseOwner).toBe('current-worker');
    expect(await completeJob(second.uid, {}, db, 'current-worker')).toBe(1);
  });

  it('merges fresh payload into a coalesced running job and marks a rerun', async () => {
    const first = await enqueueJob({
      kind: 'entity-enrichment',
      dedupeKey: 'entity:batch',
      payload: { documentIds: [1], title: 'old' },
    }, db);
    await claimNextJob({ workerId: 'entity-worker' }, db);
    const duplicate = await enqueueJob({
      kind: 'entity-enrichment',
      dedupeKey: 'entity:batch',
      payload: { documentIds: [1, 2], title: 'new' },
    }, db);

    expect(duplicate.job.uid).toBe(first.job.uid);
    expect((await getJob(first.job.uid, db)).payload).toMatchObject({
      documentIds: [1, 2], title: 'new', rerunRequested: true,
    });
    await completeJob(first.job.uid, {}, db);
  });

  it('prunes only expired finished history', async () => {
    const old = await enqueueJob({ kind: 'document-ingest' }, db);
    const claimed = await claimNextJob({ workerId: 'retention-worker' }, db);
    expect(claimed.uid).toBe(old.job.uid);
    await completeJob(claimed.uid, {}, db);
    await db('ingestion_job').where({ uid: claimed.uid }).update({ updatedAt: new Date(0) });

    expect(await pruneFinishedJobs({ completedRetentionMs: 10 * 365 * 24 * 60 * 60_000 }, db)).toBe(1);
    expect(await getJob(claimed.uid, db)).toBeUndefined();
  });
});
