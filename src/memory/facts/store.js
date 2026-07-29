import { nanoid } from 'nanoid';

import cortexDb from '../../db/cortex.js';
import { embedOrThrow } from '../../ingestion/embedder.js';
import { pgVector } from '../../lib/vectors.js';
import { maskSecrets } from '../../hooks/secret-mask.js';
import config from '../../config.js';

/**
 * Store an already-atomic memory with deterministic duplicate suppression.
 *
 * This is the path for explicit `remember` calls and facts already extracted by
 * the Stop/session-summary classifiers. Those callers have already decided what
 * the atomic statement is; sending it through the document pipeline again used
 * to classify, chunk, extract and graph-link the same sentence a second time.
 *
 * Deterministic policy:
 *   - normalized exact duplicate -> SKIP
 *   - otherwise -> ADD
 *
 * Corrections are deliberately not guessed here. They belong to an explicit
 * append-only correction API, not an LLM call hidden inside a storage method.
 */
async function saveFactDeterministic({
  content,
  category = 'key_insight',
  confidence = 'high',
  importance = 'supplementary',
  namespace,
  sourceDocumentIds = [],
  sourceSection = 'direct',
  embedding: precomputed,
}, db = cortexDb) {
  content = maskSecrets(content);
  const existing = await findExactFact(content, namespace, db);

  if (existing) {
    return {
      action: 'SKIP',
      existing,
      dedup: {
        topSimilarity: null,
        matchCount: 1,
        decision: 'normalized-exact-duplicate',
      },
    };
  }

  const embedding = precomputed || await embedOrThrow(content);
  const fact = await insertFact({
    content,
    category,
    confidence,
    importance,
    namespace,
    sourceDocumentIds,
    sourceSection,
    embedding,
  }, db);
  return {
    action: 'ADD',
    fact,
    dedup: {
      topSimilarity: null,
      matchCount: 0,
      decision: 'deterministic-add',
    },
  };
}

async function findExactFact(content, namespace, db = cortexDb) {
  const { rows } = await db.raw(`
    SELECT id, uid, content, category, status
    FROM fact
    WHERE namespace = ?
      AND status = 'active'
      AND LOWER(TRIM(content)) = LOWER(TRIM(?))
    LIMIT 1
  `, [namespace, content]);
  return rows[0] || null;
}

// ── Core CRUD ───────────────────────────────────────────────────────────────

async function insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding }, db = cortexDb) {
  const uid = `fact-${nanoid(16)}`;

  // Provenance + embedding-shape stamp.
  // - embedding_model / embedding_dim identify the vector space.
  // - created_by_agent records which agent originated this write
  //   ('claude-code' / 'codex' / 'cursor' / 'mcp' / 'cli'). PROVENANCE only —
  //   surfaced and filterable, never a retrieval scope. NULL when unknown.
  let createdByAgent = null;
  try {
    const { currentAgent } = await import('../../daemon/request-context.js');
    createdByAgent = currentAgent();
  } catch { /* request-context unavailable outside daemon — fall through */ }

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
      createdByAgent,
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

async function findByReference(idOrUid, db = cortexDb) {
  const ref = String(idOrUid ?? '').trim();
  if (!ref) return null;
  const query = db('fact');
  if (/^\d+$/.test(ref)) query.where({ id: Number(ref) });
  else query.where('uid', 'like', `${ref}%`);
  const matches = await query.orderBy('id').limit(2);
  if (matches.length > 1) {
    const err = new Error(`Fact reference "${ref}" is ambiguous; use a longer UID prefix.`);
    err.code = 'ambiguous_fact';
    throw err;
  }
  return matches[0] || null;
}

/**
 * Explicit append-only correction. The caller identifies the fact to replace;
 * Sigil never guesses contradictions from embedding similarity.
 *
 * Provider work happens before the transaction. The transaction inserts the
 * replacement, retires the old row, and records history atomically.
 */
async function correctFact(idOrUid, replacement) {
  const content = maskSecrets(String(replacement ?? '').trim());
  if (!content) {
    const err = new Error('Replacement content is required.');
    err.code = 'invalid_params';
    throw err;
  }

  const target = await findByReference(idOrUid);
  if (!target) return null;
  if (target.status !== 'active') {
    const err = new Error(`Fact ${target.uid} is already ${target.status}.`);
    err.code = 'fact_not_active';
    throw err;
  }
  if (target.content === content) {
    return { unchanged: true, previous: target, replacement: target };
  }

  // Embedding calls never hold a database transaction or lock.
  const embedding = await embedOrThrow(content);
  return cortexDb.transaction(async (trx) => {
    const current = await trx('fact').where({ id: target.id, status: 'active' }).first();
    if (!current) {
      const err = new Error(`Fact ${target.uid} changed before the correction could be applied.`);
      err.code = 'fact_changed';
      throw err;
    }

    const next = await insertFact({
      content,
      category: current.category,
      confidence: current.confidence,
      importance: current.importance,
      namespace: current.namespace,
      sourceDocumentIds: [],
      sourceSection: 'explicit-correction',
      embedding,
    }, trx);
    await markSuperseded(current.id, next.id, trx);
    await recordHistory({
      targetType: 'fact',
      targetId: current.id,
      event: 'CORRECT',
      oldContent: current.content,
      newContent: content,
      triggeredBy: 'explicit',
    }, trx);
    return { unchanged: false, previous: current, replacement: next };
  });
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
 *     superseded, no successor; full history row).
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
  return cortexDb.transaction(async (trx) => {
    // Clean historical graph rows first so databases upgraded from older Sigil
    // releases keep referential integrity even though graph runtime is gone.
    await trx.raw(
      'DELETE FROM relation WHERE source_fact_id IN (SELECT id FROM fact WHERE namespace = ?)',
      [namespace],
    );
    await trx.raw(
      'DELETE FROM fact_entity WHERE fact_id IN (SELECT id FROM fact WHERE namespace = ?)',
      [namespace],
    );
    await trx.raw(
      'DELETE FROM relation WHERE source_id IN (SELECT id FROM entity WHERE namespace = ?) OR target_id IN (SELECT id FROM entity WHERE namespace = ?)',
      [namespace, namespace],
    );

    const factsDeleted = await trx('fact').where({ namespace }).del();
    const chunksDeleted = await trx('chunk').where({ namespace }).del();
    const docsDeleted = await trx('document').where({ namespace }).del();
    const entitiesDeleted = await trx('entity').where({ namespace }).del();
    return { factsDeleted, chunksDeleted, docsDeleted, entitiesDeleted };
  });
}

export {
  saveFactDeterministic,
  insertFact,
  findByUid,
  findByReference,
  correctFact,
  listFacts,
  listByCategory,
  listByDocument,
  markSuperseded,
  supersedeStaleDocFacts,
  findExactFact,
  getFactCount,
  deleteFact,
  listNamespaces,
  deleteNamespace,
};
