import { readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import path from 'node:path';

import cortexDb from '../../db/cortex.js';
import { embed } from '../../ingestion/embedder.js';
import { prompt as llmPrompt } from '../../lib/llm.js';
import { pgVector } from '../../lib/vectors.js';
import config from '../../config.js';
import { PROMPTS_DIR } from '../../lib/paths.js';

const AUDM_PROMPT_PATH = path.join(PROMPTS_DIR, 'audm-decision.md');

// Paraphrased content with nomic-embed-text typically lands 0.75-0.88.
const SKIP_THRESHOLD = config.memory.skipThreshold;
const AMBIGUOUS_THRESHOLD = config.memory.ambiguousThreshold;

/**
 * AUDM pipeline: Add, Update, Delete (contradict), or Merge.
 * For each fact, checks similarity against existing facts and decides what to do.
 */
async function saveFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding: precomputed }) {
  const embedding = precomputed || await embed(content);
  const similar = await findSimilar(embedding, { namespace });

  if (!similar.length) {
    const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding });
    return { action: 'ADD', fact };
  }

  const topMatch = similar[0];

  if (topMatch.similarity >= SKIP_THRESHOLD) {
    return { action: 'SKIP', existing: topMatch };
  }

  if (topMatch.similarity >= AMBIGUOUS_THRESHOLD) {
    const decision = await audmDecide(content, topMatch.content);

    if (decision === 'UPDATE') {
      // Insert the new version, then mark the old one superseded with a closed valid_until.
      // This preserves the full fact history as separate rows instead of overwriting in place.
      const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding });
      await markSuperseded(topMatch.id, fact.id);
      await recordHistory({ targetType: 'fact', targetId: topMatch.id, event: 'UPDATE', oldContent: topMatch.content, newContent: content, triggeredBy: `audm:sim=${topMatch.similarity.toFixed(3)}` });
      return { action: 'UPDATE', fact, supersededId: topMatch.id };
    }

    if (decision === 'CONTRADICT') {
      const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding });
      await markContradicted(topMatch.id, fact.id);
      await recordHistory({ targetType: 'fact', targetId: topMatch.id, event: 'CONTRADICT', oldContent: topMatch.content, newContent: content, triggeredBy: `audm:sim=${topMatch.similarity.toFixed(3)}` });
      return { action: 'CONTRADICT', fact, contradictedId: topMatch.id };
    }
  }

  const fact = await insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding });
  return { action: 'ADD', fact };
}

async function audmDecide(newContent, existingContent) {
  const systemPrompt = await readFile(AUDM_PROMPT_PATH, 'utf8');

  const input = `${systemPrompt}\n\n**EXISTING FACT:** ${existingContent}\n\n**NEW FACT:** ${newContent}`;
  const text = await llmPrompt(input, { model: config.llm.decisionModel, caller: 'audm' });

  const upper = text.trim().toUpperCase();
  if (upper.includes('UPDATE')) return 'UPDATE';
  if (upper.includes('CONTRADICT')) return 'CONTRADICT';
  return 'ADD';
}

// ── Core CRUD ───────────────────────────────────────────────────────────────

async function insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding }) {
  const uid = `fact-${nanoid(16)}`;

  const [fact] = await cortexDb('fact')
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
      embedding: pgVector(embedding),
      validFrom: new Date(),
    })
    .returning('*');

  await cortexDb.raw(`
    UPDATE fact
    SET search_vector = to_tsvector('english', content)
    WHERE id = ?
  `, [fact.id]);

  return fact;
}

async function updateFact(factId, { content, category, confidence, importance, sourceDocumentIds, embedding }) {
  await cortexDb('fact')
    .where({ id: factId })
    .update({
      content,
      category,
      confidence,
      importance,
      sourceDocumentIds,
      embedding: pgVector(embedding) ?? undefined,
    });

  await cortexDb.raw(`
    UPDATE fact
    SET search_vector = to_tsvector('english', content)
    WHERE id = ?
  `, [factId]);
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

async function listByDocument(documentId) {
  return cortexDb('fact')
    .whereRaw('? = ANY(source_document_ids)', [documentId])
    .where({ status: 'active' })
    .orderBy('createdAt', 'desc');
}

async function markContradicted(factId, contradictedById) {
  await cortexDb('fact')
    .where({ id: factId })
    .update({ status: 'contradicted', contradictedById, validUntil: cortexDb.fn.now() });
}

async function markSuperseded(factId, supersededById) {
  await cortexDb('fact')
    .where({ id: factId })
    .update({ status: 'superseded', supersededById, validUntil: cortexDb.fn.now() });
}

async function findSimilar(embedding, { namespace, threshold = AMBIGUOUS_THRESHOLD, limit = 5 }) {
  const vec = pgVector(embedding);

  const { rows } = await cortexDb.raw(`
    SELECT id, uid, content, category, status,
           1 - (embedding <=> ?) as similarity
    FROM fact
    WHERE namespace = ?
      AND status = 'active'
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> ?) >= ?
    ORDER BY embedding <=> ?
    LIMIT ?
  `, [vec, namespace, vec, threshold, vec, limit]);

  return rows;
}

async function recordHistory({ targetType, targetId, event, oldContent, newContent, triggeredBy }) {
  await cortexDb('history').insert({
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
  await cortexDb('fact_lifecycle')
    .whereIn('factId', factIds)
    .update({
      accessCount: cortexDb.raw('access_count + 1'),
      lastAccessedAt: cortexDb.fn.now(),
    });
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
  // Cascade: facts, chunks, documents, entities, relations scoped to this namespace
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
  findSimilar,
  recordAccess,
  getHotFacts,
  getFactCount,
  deleteFact,
  listNamespaces,
  deleteNamespace,
};
