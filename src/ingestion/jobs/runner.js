import { createHash } from 'node:crypto';

import config from '../../config.js';
import cortexDb from '../../db/cortex.js';
import { withWriteLock } from '../../daemon/write-queue.js';
import { listByDocument } from '../../memory/facts/store.js';
import { linkDocumentEntities } from '../../memory/entities/linker.js';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  heartbeatJob,
  pruneFinishedJobs,
  recoverExpiredJobs,
  updateJobStage,
} from './store.js';

const LEASE_MS = 5 * 60_000;
const POLL_MS = 750;
const PRUNE_INTERVAL_MS = 60 * 60_000;
let currentRunner = null;

export class IngestionJobRunner {
  constructor({ concurrency = 2, log = () => {}, pollMs = POLL_MS } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.log = log;
    this.pollMs = pollMs;
    this.active = false;
    this.running = new Map();
    this.timer = null;
    this.workerSeq = 0;
    this.lastPruneAt = 0;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    const recovered = await withWriteLock(() => recoverExpiredJobs()).catch((err) => {
      // An install can briefly run new code before its migration is applied.
      // Keep the daemon alive and retry on the poll loop; status will report the
      // schema issue instead of crashing every RPC.
      this.log(`ingestion jobs unavailable: ${err.message}`);
      return 0;
    });
    if (recovered) this.log(`ingestion jobs: recovered ${recovered} expired lease(s)`);
    await this.maybePrune();
    this.kick();
  }

  async stop({ timeoutMs = 10_000 } = {}) {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running.size) return;
    await Promise.race([
      Promise.allSettled([...this.running.values()]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  kick() {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((err) => {
        this.log(`ingestion job tick failed: ${err.message}`);
        this.schedule();
      });
    }, 0);
    this.timer.unref?.();
  }

  schedule() {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((err) => {
        this.log(`ingestion job poll failed: ${err.message}`);
        this.schedule();
      });
    }, this.pollMs);
    this.timer.unref?.();
  }

  async tick() {
    if (!this.active) return;
    await this.maybePrune();
    let claimedAny = false;
    while (this.active && this.running.size < this.concurrency) {
      const workerId = `ingest-${process.pid}-${this.workerSeq++}`;
      const job = await withWriteLock(() => claimNextJob({ workerId, leaseMs: LEASE_MS }));
      if (!job) break;
      claimedAny = true;
      const work = this.run(job, workerId)
        .catch((err) => this.log(`ingestion job ${job.uid} escaped runner: ${err.message}`))
        .finally(() => {
          this.running.delete(job.uid);
          this.kick();
        });
      this.running.set(job.uid, work);
    }
    if (!claimedAny || this.running.size >= this.concurrency) this.schedule();
  }

  async run(job, workerId) {
    const heartbeat = setInterval(() => {
      withWriteLock(() => heartbeatJob(job.uid, { workerId, leaseMs: LEASE_MS })).catch(() => {});
    }, Math.floor(LEASE_MS / 3));
    heartbeat.unref?.();
    const started = Date.now();
    try {
      const result = await executeJob(job, async (stage, timing = null) => {
        const updated = await withWriteLock(() => updateJobStage(job.uid, stage, timing, undefined, workerId));
        if (!updated) throw new Error(`ingestion job ${job.uid} lease was lost`);
      });
      // Completing the current lease and inserting any dirty follow-up happen
      // in one transaction. A crash can therefore produce either the still-
      // running original or the queued successor, never a lost rerun window.
      await withWriteLock(() => cortexDb.transaction(async (trx) => {
        const latest = await getJob(job.uid, trx);
        const rerun = latest?.payload?.rerunRequested === true || result?.maintenanceRemaining === true;
        const followupPayload = { ...(latest?.payload || job.payload || {}) };
        delete followupPayload.rerunRequested;
        const updated = await completeJob(job.uid, {
          ...result,
          durationMs: Date.now() - started,
        }, trx, workerId);
        if (!updated) throw new Error(`ingestion job ${job.uid} lease was lost before completion`);
        if (rerun) {
          await enqueueJob({
            kind: job.kind,
            namespace: job.namespace,
            documentId: job.documentId,
            dedupeKey: job.dedupeKey,
            priority: job.priority,
            payload: followupPayload,
            maxAttempts: job.maxAttempts,
          }, trx);
        }
      }));
      this.log(`ingestion job ${job.uid} (${job.kind}) completed in ${Date.now() - started}ms`);
    } catch (err) {
      await withWriteLock(() => failJob(job, err, undefined, workerId)).catch(() => {});
      this.log(`ingestion job ${job.uid} (${job.kind}) failed: ${err.message}`);
      try {
        const { recordHookError } = await import('../../hooks/error-log.js');
        await recordHookError(`job:${job.kind}`, err, job.uid);
      } catch { /* diagnostics must not mask retry */ }
    } finally {
      clearInterval(heartbeat);
    }
  }

  stats() {
    return { enabled: this.active, concurrency: this.concurrency, running: this.running.size };
  }

  async maybePrune() {
    if (Date.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = Date.now();
    const pruned = await withWriteLock(() => pruneFinishedJobs()).catch((err) => {
      this.log(`ingestion job retention cleanup failed: ${err.message}`);
      return 0;
    });
    if (pruned) this.log(`ingestion jobs: pruned ${pruned} expired history row(s)`);
  }
}

async function executeJob(job, stage) {
  const payload = job.payload || {};
  if (job.kind === 'document-ingest') {
    await stage('document-core');
    const t0 = Date.now();
    const { doIngest } = await import('../../daemon/handlers/ingest-doc.js');
    const result = await doIngest({ ...payload, background: false, force: Number(job.attempts) > 1 });
    await stage('document-searchable', { name: 'coreMs', ms: Date.now() - t0 });
    return result;
  }

  if (job.kind === 'entity-enrichment') {
    await stage('load-facts');
    const documentIds = [...new Set((payload.documentIds || [job.documentId])
      .map(Number)
      .filter(Number.isFinite))];
    const loaded = await Promise.all(documentIds.map((documentId) => listByDocument(documentId)));
    const facts = [...new Map(loaded.flat().map((fact) => [fact.id, fact])).values()];
    const factResults = facts.map((fact) => ({ action: 'ADD', fact }));
    await stage('link-entities');
    const t0 = Date.now();
    const result = await linkDocumentEntities({
      title: payload.title || null,
      sourceType: payload.sourceType || 'raw',
      metadata: payload.metadata || {},
    }, factResults, job.namespace || config.defaults.namespace, payload.entities);
    await stage('entities-linked', { name: 'entityMs', ms: Date.now() - t0 });

    let maintenanceJobUid = null;
    if (result.entityCount > 0) {
      const maintenance = await enqueueAndKick({
        kind: 'relation-maintenance',
        namespace: job.namespace || config.defaults.namespace,
        dedupeKey: `relation-maintenance:${job.namespace || config.defaults.namespace}`,
        priority: -10,
        payload: { namespace: job.namespace || config.defaults.namespace },
      });
      maintenanceJobUid = maintenance.job.uid;
    }
    return { ...result, maintenanceJobUid };
  }

  if (job.kind === 'relation-maintenance') {
    await stage('derive-candidates');
    const {
      deriveCandidates,
      nameCandidates,
      applyDerived,
      recordRejectedCandidates,
    } = await import('../../memory/entities/derive-relations.js');
    const candidates = await deriveCandidates({ namespace: payload.namespace || job.namespace, limit: 50 });
    if (!candidates.candidates.length) return { judged: 0, written: 0, skipped: 0 };
    await stage('name-relations');
    const { promptJson } = await import('../../lib/llm.js');
    // Strict coverage distinguishes a real "none" verdict from an incomplete
    // or failed model batch; only the former is safe to remember permanently.
    const named = await nameCandidates(candidates.candidates, { promptJson, batchSize: 8, strict: true });
    await stage('apply-relations');
    const { canonicalizeRelationType } = await import('../../memory/entities/graph-extractor.js');
    const { createRelation } = await import('../../memory/entities/relations.js');
    const applied = await applyDerived(named, {
      canonicalize: canonicalizeRelationType,
      createRelation,
      validAt: new Date(),
    });
    const namedPairs = new Set(named.map((candidate) =>
      [Number(candidate.sourceId), Number(candidate.targetId)].sort((a, b) => a - b).join(':')));
    const rejected = candidates.candidates.filter((candidate) =>
      !namedPairs.has([Number(candidate.sourceId), Number(candidate.targetId)].sort((a, b) => a - b).join(':')));
    await recordRejectedCandidates(rejected);
    return {
      judged: candidates.candidates.length,
      named: named.length,
      rejected: rejected.length,
      maintenanceRemaining: candidates.unresolved > candidates.candidates.length,
      ...applied,
    };
  }

  throw new Error(`unknown ingestion job kind: ${job.kind}`);
}

export async function enqueueAndKick(spec) {
  const queued = await withWriteLock(() => enqueueJob(spec));
  currentRunner?.kick();
  return queued;
}

export async function queueEntityEnrichment({
  documentId,
  documentIds = null,
  namespace,
  title = null,
  sourceType = 'raw',
  metadata = {},
  entities = null,
} = {}, db = null) {
  const ids = [...new Set((documentIds || [documentId]).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!ids.length) return null;
  const batchKey = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 24);
  const spec = {
    kind: 'entity-enrichment',
    namespace,
    documentId: ids[0],
    dedupeKey: `entity-enrichment:${batchKey}`,
    payload: { documentIds: ids, title, sourceType, metadata, entities },
    maxAttempts: config.ingest.maxJobAttempts,
  };
  return db ? enqueueJob(spec, db) : enqueueAndKick(spec);
}

export function kickIngestionJobRunner() {
  currentRunner?.kick();
}

export async function startIngestionJobRunner({ log = () => {}, concurrency = config.ingest.workerConcurrency } = {}) {
  if (currentRunner) return currentRunner;
  currentRunner = new IngestionJobRunner({ concurrency, log });
  await currentRunner.start();
  return currentRunner;
}

export async function stopIngestionJobRunner() {
  const runner = currentRunner;
  currentRunner = null;
  if (runner) await runner.stop();
}

export function getIngestionJobRunner() {
  return currentRunner;
}
