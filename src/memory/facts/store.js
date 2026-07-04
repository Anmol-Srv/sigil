import { readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import path from 'node:path';

import cortexDb from '../../db/cortex.js';
import { embedOrThrow } from '../../ingestion/embedder.js';
import { prompt as llmPrompt } from '../../lib/llm.js';
import { pgHalfvecColumn, pgHalfvecParam, pgVector } from '../../lib/vectors.js';
import { maskSecrets } from '../../hooks/secret-mask.js';
import config from '../../config.js';
import { currentOrigin } from '../provenance.js';
import { PROMPTS_DIR } from '../../lib/paths.js';

const AUDM_PROMPT_PATH = path.join(PROMPTS_DIR, 'audm-decision.md');

// Paraphrased content with nomic-embed-text typically lands 0.75-0.88.
const SKIP_THRESHOLD = config.memory.skipThreshold;
const AMBIGUOUS_THRESHOLD = config.memory.ambiguousThreshold;
// Supersession scan casts a wider (lower) net than dedup — the LLM judge gates
// precision, so embedding only needs recall when hunting stale facts to retire.
const SUPERSEDE_THRESHOLD = config.memory.supersedeThreshold;
const SUPERSEDE_SCAN_LIMIT = config.memory.supersedeScanLimit;

/**
 * AUDM pipeline: Add, Update, Delete (contradict), or Merge.
 * For each fact, checks similarity against existing facts and decides what to do.
 */
async function saveFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding: precomputed }, db = cortexDb) {
  // Defense-in-depth secret masking for any caller that reaches saveFact
  // without going through the ingest pipeline's choke point. Masking BEFORE
  // the embed fallback keeps secrets out of the embedding API on this path
  // too. Idempotent — already-masked content is unchanged.
  content = maskSecrets(content);
  const embedding = precomputed || await embedOrThrow(content);
  // Scan at the (lower) supersession floor so facet-shifted stale facts surface
  // as candidates; the AUDM judge decides which are actually invalidated.
  const similar = await findSimilar(embedding, { namespace, threshold: SUPERSEDE_THRESHOLD, limit: SUPERSEDE_SCAN_LIMIT }, db);

  // AUDM telemetry attached to every return for the trace log: the similarity
  // that drove the decision, candidate count, and the thresholds in effect —
  // so the Activity log can explain *why* a fact was added vs deduped vs
  // superseded. Purely additive; existing callers ignore `audm`.
  const thresholds = { skip: SKIP_THRESHOLD, ambiguous: AMBIGUOUS_THRESHOLD, supersede: SUPERSEDE_THRESHOLD };

  if (!similar.length) {
    const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding }, db);
    return { action: 'ADD', fact, audm: { topSimilarity: null, matchCount: 0, decision: 'no-match', thresholds } };
  }

  const topMatch = similar[0];
  const audmBase = {
    topSimilarity: Number(topMatch.similarity),
    matchCount: similar.length,
    existingId: topMatch.id,
    existingContent: topMatch.content,
    thresholds,
  };

  // Near-exact duplicate of an existing active fact → skip; don't store a redundant row.
  if (topMatch.similarity >= SKIP_THRESHOLD) {
    return { action: 'SKIP', existing: topMatch, audm: { ...audmBase, decision: 'skip-duplicate' } };
  }

  // Cluster-aware supersession. A single real-world change ("migrated to
  // Postgres") decomposes into several stale facts — primary store, session
  // state, a dated event — that are NOT all the new fact's single nearest
  // neighbor. So we compare the new fact against EVERY active neighbor in the
  // ambiguous band [AMBIGUOUS, SKIP) and retire each one the (temperature-0,
  // deterministic) AUDM judge marks UPDATE/CONTRADICT — not just topMatch.
  // findSimilar already filters to >= AMBIGUOUS, so we only exclude near-dups.
  const candidates = similar.filter((s) => s.similarity < SKIP_THRESHOLD);

  if (!candidates.length) {
    const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding }, db);
    return { action: 'ADD', fact, audm: { ...audmBase, decision: 'below-ambiguous' } };
  }

  // Insert the new version once, then retire each invalidated neighbor against
  // it. Old facts become separate superseded/contradicted rows (full history
  // preserved) rather than being overwritten in place.
  const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding }, db);
  const retired = [];
  for (const cand of candidates) {
    const decision = await audmDecide(content, cand.content);
    if (decision === 'UPDATE') {
      await markSuperseded(cand.id, fact.id, db);
      await recordHistory({ targetType: 'fact', targetId: cand.id, event: 'UPDATE', oldContent: cand.content, newContent: content, triggeredBy: `audm:sim=${cand.similarity.toFixed(3)}` }, db);
      retired.push({ id: cand.id, decision: 'UPDATE', similarity: Number(cand.similarity) });
    } else if (decision === 'CONTRADICT') {
      await markContradicted(cand.id, fact.id, db);
      await recordHistory({ targetType: 'fact', targetId: cand.id, event: 'CONTRADICT', oldContent: cand.content, newContent: content, triggeredBy: `audm:sim=${cand.similarity.toFixed(3)}` }, db);
      retired.push({ id: cand.id, decision: 'CONTRADICT', similarity: Number(cand.similarity) });
    }
    // ADD → the neighbor is genuinely distinct; leave it active.
  }

  // Headline action reflects what actually happened (UPDATE wins over CONTRADICT
  // for back-compat counting; ADD when nothing was retired). `retired` carries
  // the full per-neighbor detail; supersededId/contradictedId stay populated for
  // existing callers that read the single-id contract.
  const action = retired.some((r) => r.decision === 'UPDATE') ? 'UPDATE'
    : retired.some((r) => r.decision === 'CONTRADICT') ? 'CONTRADICT'
      : 'ADD';
  return {
    action,
    fact,
    supersededId: retired.find((r) => r.decision === 'UPDATE')?.id ?? null,
    contradictedId: retired.find((r) => r.decision === 'CONTRADICT')?.id ?? null,
    retired,
    audm: { ...audmBase, decision: retired.length ? `llm:${action}×${retired.length}` : 'llm:ADD' },
  };
}

async function audmDecide(newContent, existingContent) {
  const systemPrompt = await readFile(AUDM_PROMPT_PATH, 'utf8');

  const input = `${systemPrompt}\n\n**EXISTING FACT:** ${existingContent}\n\n**NEW FACT:** ${newContent}`;
  // temperature: 0 — AUDM is a classification, not a creative call. A pinned
  // temperature makes verdicts reproducible run-to-run (the same fact pair must
  // always resolve the same way; otherwise stale-fact retirement is a coin toss).
  const text = await llmPrompt(input, { model: config.llm.decisionModel, caller: 'audm', temperature: 0 });

  const upper = text.trim().toUpperCase();
  if (upper.includes('UPDATE')) return 'UPDATE';
  if (upper.includes('CONTRADICT')) return 'CONTRADICT';
  return 'ADD';
}

// ── Core CRUD ───────────────────────────────────────────────────────────────

async function insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding }, db = cortexDb) {
  const uid = `fact-${nanoid(16)}`;

  // Provenance + embedding-shape stamp. (PR review #5.)
  // - created_by_device_id comes from the authenticated RPC caller via
  //   AsyncLocalStorage; NULL means "this device" (local CLI / hooks /
  //   master-bound MCP), matching the back-compat semantics in the
  //   migration that added the column.
  // - embedding_model / embedding_dim let cross-device sync refuse
  //   mismatched vectors at the row level (defence in depth alongside
  //   the schema manifest).
  // - created_by_agent records which agent originated this write
  //   ('claude-code' / 'codex' / 'cursor' / 'mcp' / 'cli'). PROVENANCE only —
  //   surfaced and filterable, never a retrieval scope. NULL when unknown.
  let createdByDeviceId = null;
  let createdByAgent = null;
  try {
    const { currentDeviceId, currentAgent } = await import('../../daemon/request-context.js');
    createdByDeviceId = currentDeviceId();
    createdByAgent = currentAgent();
  } catch { /* request-context unavailable outside daemon — fall through */ }

  // P7: stable ownership identity (paired device id, else local install UUID
  // from config.json), stamped on EVERY write so owner-scoped read can isolate
  // private facts per person in a shared DB. Mirrors the read-side resolution
  // in search (resolvePrivacyScope) via the shared currentOrigin() helper.
  const createdByOrigin = currentOrigin();

  const [fact] = await db('fact')
    .insert({
      uid,
      content,
      category,
      confidence: confidence || 'medium',
      importance: importance || 'supplementary',
      namespace,
      status: 'active',
      sourceDocumentIds: sourceDocumentIds || [],
      sourceSection: sourceSection || null,
      embedding: pgVector(embedding, { assertDim: true }),
      validFrom: new Date(),
      embeddingModel: config.embedding.model || null,
      embeddingDim: Number(config.embedding.dimensions) || null,
      createdByDeviceId,
      createdByAgent,
      createdByOrigin,
    })
    .returning('*');

  await db.raw(`
    UPDATE fact
    SET search_vector = to_tsvector('english', content)
    WHERE id = ?
  `, [fact.id]);

  return fact;
}

async function findByUid(uid) {
  const [fact] = await cortexDb('fact').where({ uid });
  return fact || null;
}

async function listByCategory(category, { namespace, limit = 50 } = {}) {
  const query = cortexDb('fact')
    .where({ category, status: 'active' })
    .orderBy('createdAt', 'desc')
    .limit(limit);

  if (namespace) query.where({ namespace });
  return query;
}

async function listByDocument(documentId, db = cortexDb) {
  return db('fact')
    .whereRaw('? = ANY(source_document_ids)', [documentId])
    .where({ status: 'active' })
    .orderBy('createdAt', 'desc');
}

async function markContradicted(factId, contradictedById, db = cortexDb) {
  await db('fact')
    .where({ id: factId })
    .update({ status: 'contradicted', contradictedById, validUntil: db.fn.now() });
}

async function markSuperseded(factId, supersededById, db = cortexDb) {
  await db('fact')
    .where({ id: factId })
    .update({ status: 'superseded', supersededById, validUntil: db.fn.now() });
}

/**
 * Re-ingest hygiene: when a source document's content changes, facts that were
 * extracted from the OLD content but are no longer re-confirmed by the new
 * ingest go stale. Old behaviour left them `active` forever (orphaned chunks
 * deleted, facts linger) — a slow trust-eroding leak of outdated memory.
 *
 * Rule, per fact still citing this document and NOT in keptFactIds (the facts
 * this ingest just added / updated / skipped-as-duplicate):
 *   - sole provenance (this doc is its only source) → SUPERSEDE it (status
 *     superseded, no successor; full history row). Reuses the AUDM supersede
 *     path — no new machinery.
 *   - shared provenance (other sources still attest it) → keep it active, just
 *     drop this document from source_document_ids.
 *
 * No-op for a brand-new document (all facts citing it are in keptFactIds).
 */
async function supersedeStaleDocFacts(documentId, keptFactIds = [], db = cortexDb) {
  const kept = new Set((keptFactIds || []).filter((x) => x != null));
  const current = await listByDocument(documentId, db);

  // Partition first, then issue at most three bulk statements instead of N×2
  // serial round-trips (markSuperseded + recordHistory per fact). On a large
  // re-ingest this is the difference between hundreds of awaited queries and a
  // handful.
  const toSupersede = [];
  const toDissociate = [];
  for (const f of current) {
    if (kept.has(f.id)) continue; // re-confirmed by this ingest — keep
    const docIds = Array.isArray(f.sourceDocumentIds) ? f.sourceDocumentIds : [];
    if (docIds.length <= 1) toSupersede.push(f); // sole provenance → supersede
    else toDissociate.push(f);                   // shared → drop this doc only
  }

  if (toSupersede.length) {
    const ids = toSupersede.map((f) => f.id);
    // Bulk equivalent of markSuperseded(id, null) for each.
    await db('fact')
      .whereIn('id', ids)
      .update({ status: 'superseded', supersededById: null, validUntil: db.fn.now() });
    // Single multi-row history insert.
    await db('history').insert(toSupersede.map((f) => ({
      targetType: 'fact',
      targetId: f.id,
      event: 'SUPERSEDE',
      oldContent: f.content,
      newContent: null,
      triggeredBy: `reingest:doc=${documentId}`,
    })));
  }

  if (toDissociate.length) {
    // Other sources still attest these — keep them active, drop only this doc.
    await db('fact')
      .whereIn('id', toDissociate.map((f) => f.id))
      .update({ sourceDocumentIds: db.raw('array_remove(source_document_ids, ?)', [documentId]) });
  }

  return { superseded: toSupersede.length, dissociated: toDissociate.length };
}

async function findSimilar(embedding, { namespace, threshold = AMBIGUOUS_THRESHOLD, limit = 5 }, db = cortexDb) {
  const vec = pgVector(embedding);
  const embeddingDistance = `${pgHalfvecColumn('embedding')} <=> ${pgHalfvecParam()}`;

  // AUDM dedup only needs "is there any close match" — high recall is wasted here.
  // Lower hnsw.ef_search trades recall for ANN scan speed, dropping per-fact dedup
  // cost significantly during bulk ingest. SET LOCAL only takes effect inside the
  // surrounding transaction. (Ogham §F.)
  const run = async (trx) => {
    await trx.raw('SET LOCAL hnsw.ef_search = 40');
    const { rows } = await trx.raw(`
      SELECT id, uid, content, category, status,
             1 - (${embeddingDistance}) as similarity
      FROM fact
      WHERE namespace = ?
        AND status = 'active'
        AND embedding IS NOT NULL
        AND 1 - (${embeddingDistance}) >= ?
      ORDER BY ${embeddingDistance}
      LIMIT ?
    `, [vec, namespace, vec, threshold, vec, limit]);
    return rows;
  };
  // When called inside an ingest transaction, run on THAT transaction — so
  // within-batch dedup sees facts inserted earlier in the same (uncommitted)
  // ingest, and SET LOCAL scopes to it. Standalone callers get their own tx.
  return db.isTransaction ? run(db) : db.transaction(run);
}

async function recordHistory({ targetType, targetId, event, oldContent, newContent, triggeredBy }, db = cortexDb) {
  await db('history').insert({
    targetType,
    targetId,
    event,
    oldContent: oldContent || null,
    newContent: newContent || null,
    triggeredBy: triggeredBy || null,
  });
}

async function recordAccess(factIds) {
  if (!factIds.length) return;
  // Writes to the skinny fact_lifecycle table — does NOT touch the fact row
  // (which is in the HNSW index). Prevents index bloat on every search hit.
  //
  // Also flips stable → editing on access. The editing window is when new
  // contradicting/refining facts can update this fact more freely (the AUDM
  // path treats "editing" stage as receptive). closeEditingWindows() in the
  // stage manager flips it back to stable after 30 minutes.
  await cortexDb.raw(
    `UPDATE fact_lifecycle
     SET access_count = access_count + 1,
         last_accessed_at = NOW(),
         stage = CASE WHEN stage = 'stable' THEN 'editing' ELSE stage END,
         stage_entered_at = CASE WHEN stage = 'stable' THEN NOW() ELSE stage_entered_at END
     WHERE fact_id = ANY(?)`,
    [factIds],
  );
}

async function getHotFacts(namespace, { limit = 10, since } = {}) {
  const query = cortexDb('fact as f')
    .join('fact_lifecycle as fl', 'fl.fact_id', 'f.id')
    .where({ 'f.status': 'active' })
    .where('fl.access_count', '>', 0)
    .orderBy('fl.access_count', 'desc')
    .limit(limit)
    .select('f.*');

  if (namespace) query.where({ 'f.namespace': namespace });
  if (since) query.where('fl.last_accessed_at', '>=', since);

  return query;
}

async function listFacts({ namespace, limit = 50, offset = 0, category } = {}) {
  const query = cortexDb('fact')
    .where({ status: 'active' })
    .select('id', 'uid', 'content', 'category', 'confidence', 'importance', 'createdAt', 'namespace')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .offset(offset);

  if (namespace) query.where({ namespace });
  if (category) query.where({ category });
  return query;
}

async function getFactCount(namespace) {
  const query = cortexDb('fact').where({ status: 'active' });
  if (namespace) query.where({ namespace });
  const [{ count }] = await query.count('id as count');
  return Number(count);
}

async function deleteFact(idOrUid) {
  const isUid = typeof idOrUid === 'string' && idOrUid.length > 8;
  const where = isUid ? { uid: idOrUid } : { id: Number(idOrUid) };

  // Clean up junction table first
  const fact = await cortexDb('fact').where(where).first();
  if (!fact) return null;

  await cortexDb('fact_entity').where({ factId: fact.id }).del();
  await cortexDb('fact').where({ id: fact.id }).del();
  return fact;
}

async function listNamespaces() {
  const rows = await cortexDb('fact')
    .where({ status: 'active' })
    .select('namespace')
    .count('id as factCount')
    .groupBy('namespace')
    .orderBy('namespace');
  return rows.map((r) => ({ namespace: r.namespace, factCount: Number(r.factCount) }));
}

async function deleteNamespace(namespace) {
  // Foreign-key dependency order: relations and fact_entity rows reference fact ids,
  // so they must go before fact rows. Same for entity/document descendants.
  await cortexDb.raw(
    'DELETE FROM relation WHERE source_fact_id IN (SELECT id FROM fact WHERE namespace = ?)',
    [namespace],
  );
  await cortexDb.raw(
    'DELETE FROM fact_entity WHERE fact_id IN (SELECT id FROM fact WHERE namespace = ?)',
    [namespace],
  );
  // Relations may also reference entities in this namespace (column is source_id / target_id, not *_entity_id)
  await cortexDb.raw(
    'DELETE FROM relation WHERE source_id IN (SELECT id FROM entity WHERE namespace = ?) OR target_id IN (SELECT id FROM entity WHERE namespace = ?)',
    [namespace, namespace],
  );

  const factsDeleted = await cortexDb('fact').where({ namespace }).del();
  const chunksDeleted = await cortexDb('chunk').where({ namespace }).del();
  const docsDeleted = await cortexDb('document').where({ namespace }).del();
  const entitiesDeleted = await cortexDb('entity').where({ namespace }).del();
  return { factsDeleted, chunksDeleted, docsDeleted, entitiesDeleted };
}

export {
  saveFact,
  insertFact,
  findByUid,
  listFacts,
  listByCategory,
  listByDocument,
  markContradicted,
  markSuperseded,
  supersedeStaleDocFacts,
  findSimilar,
  recordAccess,
  getHotFacts,
  getFactCount,
  deleteFact,
  listNamespaces,
  deleteNamespace,
};
