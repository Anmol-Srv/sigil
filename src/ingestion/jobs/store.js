import { nanoid } from 'nanoid';

import cortexDb from '../../db/cortex.js';

const ACTIVE = ['queued', 'running'];

export async function enqueueJob({
  kind,
  payload = {},
  namespace = null,
  documentId = null,
  dedupeKey = null,
  priority = 0,
  maxAttempts = 3,
  rerunIfRunning = true,
} = {}, db = cortexDb) {
  if (!kind) throw new Error('enqueueJob: kind is required');
  const row = {
    uid: `job-${nanoid(16)}`,
    kind,
    status: 'queued',
    stage: 'queued',
    namespace,
    documentId,
    dedupeKey,
    priority,
    payload,
    maxAttempts,
    availableAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const [created] = await db('ingestion_job').insert(row).returning('*');
    return { job: created, created: true };
  } catch (err) {
    // Coalesced maintenance can be enqueued by several documents at once. The
    // partial unique index keeps only one active row; return it as the durable
    // acknowledgement rather than turning an intentional race into failure.
    if (!dedupeKey || err?.code !== '23505') throw err;
    const existing = await db('ingestion_job')
      .where({ dedupeKey })
      .whereIn('status', ACTIVE)
      .orderBy('createdAt', 'asc')
      .first();
    if (!existing) throw err;
    const mergedPayload = {
      ...(payload || {}),
      ...(existing.status === 'running' && rerunIfRunning ? { rerunRequested: true } : {}),
    };
    if (Object.keys(mergedPayload).length) {
      // A coalesced maintenance job may already have taken its candidate
      // snapshot. Mark it dirty so the runner schedules one follow-up after
      // completion. Queued jobs simply absorb the freshest payload before they
      // start; running jobs keep an explicit durable rerun marker.
      await db('ingestion_job').where({ id: existing.id }).update({
        payload: db.raw("payload || ?::jsonb", [JSON.stringify(mergedPayload)]),
        updatedAt: db.fn.now(),
      });
      existing.payload = { ...(existing.payload || {}), ...mergedPayload };
    }
    return { job: existing, created: false };
  }
}

export async function recoverExpiredJobs(db = cortexDb) {
  return db('ingestion_job')
    .where({ status: 'running' })
    .where('leaseExpiresAt', '<', db.fn.now())
    .update({
      status: 'queued',
      stage: 'recovered',
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: db.fn.now(),
      updatedAt: db.fn.now(),
      error: db.raw("COALESCE(error || E'\\n', '') || ?", ['lease expired; recovered after daemon interruption']),
    });
}

export async function claimNextJob({ workerId, leaseMs = 5 * 60_000 } = {}, db = cortexDb) {
  if (!workerId) throw new Error('claimNextJob: workerId is required');
  return db.transaction(async (trx) => {
    await recoverExpiredJobs(trx);
    const job = await trx('ingestion_job')
      .where({ status: 'queued' })
      .where('availableAt', '<=', trx.fn.now())
      .orderBy('priority', 'desc')
      .orderBy('createdAt', 'asc')
      .forUpdate()
      .skipLocked()
      .first();
    if (!job) return null;

    const now = new Date();
    const [claimed] = await trx('ingestion_job')
      .where({ id: job.id, status: 'queued' })
      .update({
        status: 'running',
        stage: 'claimed',
        attempts: job.attempts + 1,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        startedAt: job.startedAt || now,
        updatedAt: now,
        timings: {
          ...(job.timings || {}),
          queueWaitMs: Math.max(0, now.getTime() - new Date(job.createdAt).getTime()),
        },
      })
      .returning('*');
    return claimed || null;
  });
}

export async function heartbeatJob(uid, { workerId, leaseMs = 5 * 60_000 } = {}, db = cortexDb) {
  return db('ingestion_job')
    .where({ uid, status: 'running', leaseOwner: workerId })
    .update({ leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: db.fn.now() });
}

export async function updateJobStage(uid, stage, timing = null, db = cortexDb, leaseOwner = null) {
  const patch = { stage, updatedAt: db.fn.now() };
  if (timing && timing.name) {
    patch.timings = db.raw("timings || ?::jsonb", [JSON.stringify({ [timing.name]: timing.ms })]);
  }
  const query = db('ingestion_job').where({ uid, status: 'running' });
  if (leaseOwner) query.where({ leaseOwner });
  return query.update(patch);
}

export async function completeJob(uid, result = {}, db = cortexDb, leaseOwner = null) {
  const query = db('ingestion_job').where({ uid, status: 'running' });
  if (leaseOwner) query.where({ leaseOwner });
  return query.update({
    status: 'completed',
    stage: 'completed',
    result,
    // The canonical masked source is now on document.content. Clearing staged
    // bytes prevents the queue history from doubling document storage forever.
    payload: {},
    error: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: db.fn.now(),
    updatedAt: db.fn.now(),
  });
}

export async function failJob(job, err, db = cortexDb, leaseOwner = null) {
  const terminal = Number(job.attempts) >= Number(job.maxAttempts);
  const delayMs = Math.min(60_000, 1000 * (2 ** Math.max(0, Number(job.attempts) - 1)));
  const query = db('ingestion_job').where({ uid: job.uid, status: 'running' });
  if (leaseOwner) query.where({ leaseOwner });
  return query.update({
    status: terminal ? 'failed' : 'queued',
    stage: terminal ? 'failed' : 'retry-wait',
    error: String(err?.stack || err?.message || err).slice(0, 20_000),
    availableAt: terminal ? job.availableAt : new Date(Date.now() + delayMs),
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: terminal ? db.fn.now() : null,
    updatedAt: db.fn.now(),
  });
}

export async function getJob(uid, db = cortexDb) {
  return db('ingestion_job').where({ uid }).first();
}

export async function getJobStats({ namespace = null } = {}, db = cortexDb) {
  const base = () => {
    const q = db('ingestion_job');
    if (namespace) q.where({ namespace });
    return q;
  };
  const rows = await base().select('status').count('id as count').groupBy('status');
  const oldest = await base().whereIn('status', ACTIVE).orderBy('createdAt', 'asc').first('createdAt');
  const recentFailures = await base()
    .where({ status: 'failed' })
    .orderBy('updatedAt', 'desc')
    .limit(3)
    .select('uid', 'kind', 'stage', 'attempts', 'error', 'updatedAt');
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return {
    ...counts,
    active: counts.queued + counts.running,
    oldestActiveMs: oldest ? Math.max(0, Date.now() - new Date(oldest.createdAt).getTime()) : 0,
    recentFailures: recentFailures.map((job) => ({
      ...job,
      error: String(job.error || '').split('\n')[0].slice(0, 300),
    })),
  };
}

export async function pruneFinishedJobs({
  completedRetentionMs = 7 * 24 * 60 * 60_000,
  failedRetentionMs = 30 * 24 * 60 * 60_000,
} = {}, db = cortexDb) {
  const now = Date.now();
  return db('ingestion_job')
    .where((query) => {
      query.where((completed) => completed
        .where({ status: 'completed' })
        .where('updatedAt', '<', new Date(now - completedRetentionMs)))
        .orWhere((failed) => failed
          .where({ status: 'failed' })
          .where('updatedAt', '<', new Date(now - failedRetentionMs)));
    })
    .delete();
}
