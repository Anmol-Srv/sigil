/**
 * repair.embeddings — heal a corpus whose vectors are missing or stale.
 *
 * Two classes of damage this fixes:
 *   - NULL embeddings: a fact/chunk stored before the guarded embed boundary
 *     (embedBatchOrThrow) existed, or under an old code path, can have a NULL
 *     embedding — real-but-invisible to vector search (`WHERE embedding IS NOT
 *     NULL`). Re-embed and fill it.
 *   - Stale model: a fact embedded under a different model than the one now
 *     configured ranks meaninglessly against fresh queries (mixed-embedder
 *     corpus). Re-embed it under the current model so the whole corpus shares
 *     one vector space. (Chunks carry no model stamp, so model-mix repair is
 *     facts-only unless --all-chunks re-embeds every chunk.)
 *
 * Idempotent and resumable: each fixed row stops matching the filter, so the
 * loop pages forward by simply re-querying. If the embedder dies mid-run, a
 * re-run continues where it left off. Re-embedding routes through
 * embedBatchOrThrow, so a provider failure stops cleanly (nothing half-written).
 */
import cortexDb from '../../db/cortex.js';
import config from '../../config.js';
import { EMBEDDING_DIM } from '../../lib/constants.js';
import { embedBatchOrThrow } from '../../ingestion/embedder.js';
import { pgVector } from '../../lib/vectors.js';
import { resyncSequences } from '../../db/migrate.js';

const BATCH = 100;

export function registerRepair(registry) {
  // repair.sequences — heal a desynced serial sequence in place (finding 6.6).
  // Runs against the daemon's pool (sole DB owner), so it's safe in embedded
  // mode and needs no reset. No-op on a healthy DB.
  registry.register('repair.sequences', async () => resyncSequences(cortexDb));

  // repair.db — embedded-cluster recovery (F3). `status` lists the snapshots and
  // current health; `restore` rebuilds ~/.sigil/db from a snapshot. Restore is
  // NON-DESTRUCTIVE: the current (torn) dir is moved aside, never deleted. Runs
  // in the daemon (sole DB owner): it drops the pool, swaps the dir, and reopens.
  registry.register('repair.db', async (params = {}) => {
    const { default: cfg } = await import('../../config.js');
    if (cfg.db.mode !== 'embedded') {
      const err = new Error('`repair db` applies to the built-in engine only; server Postgres is managed externally.');
      err.code = 'not_embedded';
      throw err;
    }
    const { listSnapshots, recoverFromSnapshot } = await import('../../db/snapshots.js');
    const { getDbHealth, setDbHealth } = await import('../registry-holder.js');
    const action = params.action || 'status';

    if (action === 'status') {
      const snapshots = listSnapshots().map((s) => ({ name: s.name, bytes: s.size, mtimeMs: s.mtimeMs }));
      return { action, health: getDbHealth(), snapshots };
    }

    if (action === 'restore') {
      const which = params.which || 'latest';
      const { resetCortexPool } = await import('../../db/cortex.js');
      await resetCortexPool(); // drop the dead pool + WASM instance before the dir moves
      const r = await recoverFromSnapshot({ which });
      if (!r.restored) {
        const err = new Error(`restore failed: ${r.reason}`);
        err.code = r.reason;
        throw err;
      }
      let healthy = false; let error = null;
      try { await cortexDb.raw('SELECT 1'); healthy = true; } // re-probe on the fresh dir
      catch (err) { error = err.message; }
      setDbHealth({ healthy, error, checkedAt: Date.now() });
      return { action, restored: true, from: r.from, movedAside: r.movedAside, healthy };
    }

    const err = new Error(`unknown \`repair db\` action: ${action}`);
    err.code = 'bad_action';
    throw err;
  });

  registry.register('repair.embeddings', async (params = {}) => {
    const dryRun = Boolean(params.dryRun);
    const namespace = params.namespace || null;
    const allChunks = Boolean(params.allChunks);
    const model = config.embedding.model || null;
    const dim = Number(config.embedding.dimensions) || EMBEDDING_DIM;

    if (!model) {
      const err = new Error('No embedding model configured — run `sigil init` before repairing.');
      err.code = 'invalid_config';
      throw err;
    }

    // Facts needing repair: NULL embedding, no model stamp, or a different model.
    const factFilter = (q) => {
      if (namespace) q.where({ namespace });
      return q.where({ status: 'active' }).andWhere(function applyOr() {
        this.whereNull('embedding')
          .orWhereNull('embeddingModel')
          .orWhereNot('embeddingModel', model);
      });
    };

    // Chunks: NULL embedding only (no per-chunk model stamp). --all-chunks
    // re-embeds every chunk regardless (used after a provider switch).
    const chunkFilter = (q) => {
      if (namespace) q.where({ namespace });
      if (!allChunks) q.whereNull('embedding');
      return q;
    };

    const factTotal = Number((await factFilter(cortexDb('fact')).count({ c: '*' }))[0]?.c || 0);
    const chunkTotal = Number((await chunkFilter(cortexDb('chunk')).count({ c: '*' }))[0]?.c || 0);

    if (dryRun) {
      let spoolPending = 0;
      try { spoolPending = (await import('../../hooks/stop-spool.js')).spoolCount(); } catch { /* */ }
      return { dryRun: true, namespace, model, facts: { scanned: factTotal, repaired: 0 }, chunks: { scanned: chunkTotal, repaired: 0 }, spool: { pending: spoolPending } };
    }

    let factsRepaired = 0;
    // Facts page forward naturally: a repaired row's embeddingModel now equals
    // `model`, so it drops out of the filter on the next query.
    for (;;) {
      const rows = await factFilter(cortexDb('fact')).select('id', 'content').limit(BATCH);
      if (!rows.length) break;
      const vectors = await embedBatchOrThrow(rows.map((r) => r.content));
      for (let i = 0; i < rows.length; i++) {
        await cortexDb('fact').where({ id: rows[i].id }).update({
          embedding: pgVector(vectors[i], { assertDim: true }),
          embeddingModel: model,
          embeddingDim: dim,
        });
        factsRepaired++;
      }
    }

    let chunksRepaired = 0;
    // With --all-chunks the filter never shrinks, so page by ascending id.
    let lastId = 0;
    for (;;) {
      const q = chunkFilter(cortexDb('chunk')).select('id', 'content', 'contextualPrefix').orderBy('id', 'asc').limit(BATCH);
      if (allChunks) q.where('id', '>', lastId);
      const rows = await q;
      if (!rows.length) break;
      const texts = rows.map((r) => (r.contextualPrefix ? `${r.contextualPrefix}\n${r.content}` : r.content));
      const vectors = await embedBatchOrThrow(texts);
      for (let i = 0; i < rows.length; i++) {
        await cortexDb('chunk').where({ id: rows[i].id }).update({
          embedding: pgVector(vectors[i], { assertDim: true }),
        });
        chunksRepaired++;
        lastId = rows[i].id;
      }
    }

    // Also replay any Stop-hook saves that failed during an outage.
    let spool = { drained: 0, remaining: 0, replayed: 0 };
    try {
      const { drainStopSpool } = await import('../../hooks/stop-spool.js');
      spool = await drainStopSpool();
    } catch { /* best effort */ }

    return {
      dryRun: false,
      namespace,
      model,
      facts: { scanned: factTotal, repaired: factsRepaired },
      chunks: { scanned: chunkTotal, repaired: chunksRepaired },
      spool,
    };
  });
}
