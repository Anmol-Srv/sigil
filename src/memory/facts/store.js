import { readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import path from 'node:path';

import cortexDb from '../../db/cortex.js';
import { embedOrThrow } from '../../ingestion/embedder.js';
import { promptJson } from '../../lib/llm.js';
import { pgHalfvecColumn, pgHalfvecParam, pgVector } from '../../lib/vectors.js';
import { maskSecrets } from '../../hooks/secret-mask.js';
import config from '../../config.js';
import { PROMPTS_DIR } from '../../lib/paths.js';
import { inferVisibility, normalizeVisibility, VISIBILITIES } from '../visibility.js';

const AUDM_PROMPT_PATH = path.join(PROMPTS_DIR, 'audm-decision.md');

// Read thresholds at operation time. Settings are editable while the daemon is
// running; freezing them at module import made the dashboard controls lie until
// the next restart. `thresholds()` is deliberately tiny and side-effect free so
// tests can change config between calls too.
function thresholds() {
  return {
    skip: Number(config.memory.skipThreshold),
    ambiguous: Number(config.memory.ambiguousThreshold),
    supersede: Number(config.memory.supersedeThreshold),
    scanLimit: Number(config.memory.supersedeScanLimit),
  };
}

/**
 * AUDM pipeline: Add, Update, Delete (contradict), or Merge.
 * For each fact, checks similarity against existing facts and decides what to do.
 */
async function saveFact(spec, db = cortexDb) {
  const prepared = await prepareFactBatch([spec], { db });
  // A caller that explicitly supplied a transaction retains atomicity, but the
  // expensive preparation above has already finished before we write anything.
  // Normal callers get a short transaction containing SQL only.
  const apply = (trx) => applyPreparedFactBatch(prepared, { db: trx });
  const results = db.isTransaction ? await apply(db) : await db.transaction(apply);
  return results[0];
}

/**
 * Prepare every fact in one batch: embeddings are supplied by the ingestion
 * layer, similarity reads happen without a write transaction, and every AUDM
 * pair is adjudicated in ONE structured model call. No writes occur here.
 */
async function prepareFactBatch(specs, { db = cortexDb } = {}) {
  const t = thresholds();
  const prepared = [];
  const offeredPairs = [];

  const normalized = await Promise.all(specs.map(async (raw) => {
    const content = maskSecrets(raw.content);
    const embedding = raw.embedding || await embedOrThrow(content);
    return { ...raw, content, embedding };
  }));
  // Server Postgres can run these ANN reads concurrently. Embedded PGlite's
  // max-1 pool naturally serializes them without changing semantics.
  const candidateSets = await Promise.all(normalized.map((spec) => findSimilar(spec.embedding, {
    namespace: spec.namespace,
    threshold: t.supersede,
    limit: t.scanLimit,
  }, db)));

  for (let index = 0; index < normalized.length; index++) {
    const raw = normalized[index];
    const { content, embedding } = raw;
    const dbCandidates = candidateSets[index];

    // Preserve within-batch dedup without inserting one fact at a time. Earlier
    // incoming facts are real candidates too; cosine is deterministic and local.
    const batchCandidates = prepared
      .map((p, priorIndex) => ({
        candidateKey: `input:${priorIndex}`,
        inputIndex: priorIndex,
        content: p.spec.content,
        category: p.spec.category,
        similarity: cosineSimilarity(embedding, p.spec.embedding),
      }))
      .filter((c) => c.similarity >= t.supersede);

    const candidates = [
      ...dbCandidates.map((c) => ({ ...c, candidateKey: `fact:${c.id}` })),
      ...batchCandidates,
    ]
      .sort((a, b) => Number(b.similarity) - Number(a.similarity))
      .slice(0, t.scanLimit);
    const top = candidates[0] || null;
    const duplicate = top && Number(top.similarity) >= t.skip ? top : null;

    // `ambiguousThreshold` is the gate that decides whether the model is asked.
    // Once a strong cluster match exists, include lower-similarity members down
    // to the supersede floor so one real-world change can retire the whole stale
    // cluster in the same call.
    const judged = !duplicate && top && Number(top.similarity) >= t.ambiguous
      ? candidates.filter((c) => Number(c.similarity) < t.skip)
      : [];

    for (const candidate of judged) {
      offeredPairs.push({
        inputIndex: index,
        candidateKey: candidate.candidateKey,
        newContent: content,
        existingContent: candidate.content,
        similarity: Number(candidate.similarity),
      });
    }

    prepared.push({
      spec: { ...raw, content, embedding },
      candidates,
      duplicate,
      judged,
      decisions: new Map(),
      thresholds: t,
    });
  }

  const decisions = await audmDecideBatch(offeredPairs);
  for (const pair of offeredPairs) {
    prepared[pair.inputIndex].decisions.set(
      pair.candidateKey,
      decisions.get(`${pair.inputIndex}|${pair.candidateKey}`) || 'ADD',
    );
  }
  return prepared;
}

/** Apply a prepared batch. SQL only: safe to call inside a short transaction. */
async function applyPreparedFactBatch(prepared, { db = cortexDb } = {}) {
  const results = [];

  for (let index = 0; index < prepared.length; index++) {
    const plan = prepared[index];
    const top = plan.candidates[0] || null;
    const audmBase = {
      topSimilarity: top ? Number(top.similarity) : null,
      matchCount: plan.candidates.length,
      existingId: top?.id ?? null,
      existingContent: top?.content ?? null,
      thresholds: {
        skip: plan.thresholds.skip,
        ambiguous: plan.thresholds.ambiguous,
        supersede: plan.thresholds.supersede,
      },
    };

    // Preparation runs concurrently outside the write lock. Revalidate exact
    // content under the short commit transaction so two callers that prepared
    // the same unseen fact cannot both insert it. Semantic near-duplicates were
    // already handled by the batched AUDM pass; this is the optimistic race
    // guard for the common identical-input case.
    const concurrentExact = await findActiveExact(plan.spec, db);
    if (concurrentExact) {
      const existing = await mergeFactSourceDocuments(concurrentExact, plan.spec.sourceDocumentIds, db);
      results.push({ action: 'SKIP', existing, audm: { ...audmBase, decision: 'skip-concurrent-exact' } });
      continue;
    }

    if (plan.duplicate) {
      let existing = resolvePreparedCandidate(plan.duplicate, results);
      if (existing) {
        existing = await mergeFactSourceDocuments(existing, plan.spec.sourceDocumentIds, db);
        results.push({ action: 'SKIP', existing, audm: { ...audmBase, decision: 'skip-duplicate' } });
        continue;
      }
    }

    const fact = await insertFact(plan.spec, db);
    const retired = [];
    const retiredIds = new Set();
    for (const candidate of plan.judged) {
      const decision = plan.decisions.get(candidate.candidateKey) || 'ADD';
      if (decision === 'ADD') continue;
      const existing = resolvePreparedCandidate(candidate, results);
      if (!existing?.id || existing.id === fact.id || retiredIds.has(existing.id)) continue;

      if (decision === 'UPDATE') await markSuperseded(existing.id, fact.id, db);
      else if (decision === 'CONTRADICT') await markContradicted(existing.id, fact.id, db);
      else continue;
      await recordHistory({
        targetType: 'fact', targetId: existing.id, event: decision,
        oldContent: existing.content, newContent: plan.spec.content,
        triggeredBy: `audm:sim=${Number(candidate.similarity).toFixed(3)}`,
      }, db);
      retiredIds.add(existing.id);
      retired.push({ id: existing.id, decision, similarity: Number(candidate.similarity) });
    }

    const action = retired.some((r) => r.decision === 'UPDATE') ? 'UPDATE'
      : retired.some((r) => r.decision === 'CONTRADICT') ? 'CONTRADICT'
        : 'ADD';
    results.push({
      action,
      fact,
      supersededId: retired.find((r) => r.decision === 'UPDATE')?.id ?? null,
      contradictedId: retired.find((r) => r.decision === 'CONTRADICT')?.id ?? null,
      retired,
      audm: {
        ...audmBase,
        decision: retired.length ? `llm:${action}×${retired.length}`
          : plan.judged.length ? 'llm:ADD' : top ? 'below-ambiguous' : 'no-match',
      },
    });
  }

  return results;
}

async function findActiveExact({ content, namespace }, db) {
  return db('fact')
    .where({ namespace, status: 'active', content })
    .whereRaw('md5(content) = md5(?)', [content])
    .first();
}

function resolvePreparedCandidate(candidate, results) {
  if (candidate.inputIndex == null) return candidate;
  const prior = results[candidate.inputIndex];
  return prior?.fact || prior?.existing || null;
}

async function mergeFactSourceDocuments(existing, sourceDocumentIds, db) {
  const incoming = (sourceDocumentIds || []).map(Number).filter(Number.isFinite);
  if (!existing?.id || !incoming.length) return existing;
  const current = Array.isArray(existing.sourceDocumentIds) ? existing.sourceDocumentIds.map(Number) : [];
  const merged = [...new Set([...current, ...incoming])];
  if (merged.length === current.length && merged.every((id, i) => id === current[i])) return existing;
  await db('fact').where({ id: existing.id }).update({ sourceDocumentIds: merged });
  return { ...existing, sourceDocumentIds: merged };
}

async function audmDecideBatch(pairs) {
  if (!pairs.length) return new Map();
  const systemPrompt = await readFile(AUDM_PROMPT_PATH, 'utf8');
  const cases = pairs.map((p) => ({
    input_index: p.inputIndex,
    candidate_key: p.candidateKey,
    existing_fact: p.existingContent,
    new_fact: p.newContent,
    similarity: Number(p.similarity.toFixed(4)),
  }));
  const input = `${systemPrompt}\n\nDecide every case below independently. Return one decision per offered pair.\n\n${JSON.stringify(cases)}`;
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            input_index: { type: 'integer' },
            candidate_key: { type: 'string' },
            action: { type: 'string', enum: ['ADD', 'UPDATE', 'CONTRADICT'] },
          },
          required: ['input_index', 'candidate_key', 'action'],
        },
      },
    },
    required: ['decisions'],
  };
  const parsed = await promptJson(input, {
    model: config.llm.decisionModel,
    caller: 'audm-batch',
    temperature: 0,
    schema,
  });

  const offered = new Set(pairs.map((p) => `${p.inputIndex}|${p.candidateKey}`));
  const out = new Map();
  for (const d of Array.isArray(parsed?.decisions) ? parsed.decisions : []) {
    const key = `${d.input_index}|${d.candidate_key}`;
    if (!offered.has(key)) continue;
    if (!['ADD', 'UPDATE', 'CONTRADICT'].includes(d.action)) continue;
    out.set(key, d.action);
  }
  if (out.size !== offered.size) {
    throw new Error(`AUDM judge returned ${out.size}/${offered.size} required decisions`);
  }
  return out;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

// ── Core CRUD ───────────────────────────────────────────────────────────────

async function insertFact({ content, category, confidence, importance, namespace, sourceDocumentIds, sourceSection, embedding, visibility }, db = cortexDb) {
  const uid = `fact-${nanoid(16)}`;

  // Visibility: an explicit value from the caller always wins (a `--visibility`
  // flag or an RPC param is a deliberate act). Otherwise infer, which returns
  // 'shared' for all but a narrow class of assistant-directed instructions.
  const resolvedVisibility = visibility
    ? normalizeVisibility(visibility)
    : inferVisibility(content, { category });

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
      visibility: resolvedVisibility,
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

async function countActiveByDocuments(documentIds, db = cortexDb) {
  const ids = [...new Set((documentIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  const { rows } = await db.raw(`
    SELECT requested.document_id AS "documentId", COUNT(f.id)::int AS count
    FROM unnest(?::bigint[]) AS requested(document_id)
    LEFT JOIN fact f
      ON f.status = 'active'
     AND requested.document_id = ANY(f.source_document_ids)
    GROUP BY requested.document_id
  `, [ids]);
  return new Map(rows.map((row) => [Number(row.documentId), Number(row.count)]));
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

async function findSimilar(embedding, { namespace, threshold = null, limit = 5 }, db = cortexDb) {
  const resolvedThreshold = threshold ?? thresholds().ambiguous;
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
    `, [vec, namespace, vec, resolvedThreshold, vec, limit]);
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
    // visibility is selected but NOT filtered on: the human browsing their own
    // store must see every fact, and must be able to SEE that one is scoped to
    // a single agent. Hiding the scoping from the owner is how a memory system
    // becomes unpredictable — the surprise is never "why is this here", it is
    // always "where did my fact go".
    .select('id', 'uid', 'content', 'category', 'confidence', 'importance', 'createdAt', 'namespace', 'visibility')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .offset(offset);

  if (namespace) query.where({ namespace });
  if (category) query.where({ category });
  return query;
}

/**
 * Change a stored fact's visibility.
 *
 * Every surveyed sync system specifies the initial decision well and the
 * CHANGE badly — what happens to already-replicated copies when an item stops
 * being syncable is left undefined almost everywhere. Sigil gets to answer it
 * cleanly because a shared database has exactly one row: there is no other
 * copy to chase, no tombstone to propagate, and the next read on every device
 * sees the new value. Narrowing a fact takes effect everywhere immediately,
 * and widening it brings the fact back rather than resurrecting a stale one.
 *
 * Accepts a numeric id, a full uid, or a uid prefix — same contract as
 * forgetFact, because they get used in the same breath.
 */
async function setFactVisibility(idOrUid, visibility) {
  const wanted = normalizeVisibility(visibility);
  if (!VISIBILITIES.includes(visibility)) {
    const err = new Error(`visibility must be one of: ${VISIBILITIES.join(', ')}`);
    err.code = 'invalid_params';
    throw err;
  }

  const arg = String(idOrUid ?? '').trim();
  if (!arg) {
    const err = new Error('setFactVisibility: id or uid required');
    err.code = 'invalid_params';
    throw err;
  }

  const [match] = /^\d+$/.test(arg)
    ? await cortexDb('fact').where({ id: Number(arg) }).limit(1)
    : await cortexDb('fact').where('uid', 'like', `${arg}%`).limit(1);
  if (!match) return { notFound: true, query: arg };

  const previous = match.visibility;
  await cortexDb('fact').where({ id: match.id }).update({ visibility: wanted });

  // Recorded in history for the same reason every other mutation is: a fact
  // that silently stops appearing for one agent is indistinguishable from a
  // retrieval bug unless something says when it changed and to what.
  await recordHistory({
    targetType: 'fact',
    targetId: match.id,
    event: 'VISIBILITY',
    oldContent: previous,
    newContent: wanted,
    triggeredBy: 'manual',
  });

  return { uid: match.uid, content: match.content, from: previous, to: wanted };
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

  const fact = await cortexDb('fact').where(where).first();
  if (!fact) return null;

  // A fact is the target of several foreign keys. Deleting the row without
  // clearing them first throws — e.g. relation_source_fact_id_foreign (the
  // fact is the source of a relation) or fact_superseded_by_id_foreign
  // (another fact points at it via superseded_by_id). Cascade the cleanup in
  // a single transaction so `forget` is atomic and never leaves dangling refs.
  await cortexDb.transaction(async (trx) => {
    // 1. Null self-referential pointers FROM other facts TO this one.
    await trx('fact').where({ supersededById: fact.id }).update({ supersededById: null });
    await trx('fact').where({ contradictedById: fact.id }).update({ contradictedById: null });

    // 2. Delete rows that hard-reference the fact.
    await trx('relation').where({ sourceFactId: fact.id }).del();
    await trx('hebbian_edge').where({ factAId: fact.id }).orWhere({ factBId: fact.id }).del();
    await trx('fact_entity').where({ factId: fact.id }).del();
    await trx('fact_lifecycle').where({ factId: fact.id }).del();

    // 3. Decrement each owning pod's fact counter, then detach memberships.
    //    Done via a subquery (no rows read into JS) so it doesn't depend on
    //    response key casing. Counter update must run before the delete.
    await trx('pod')
      .whereIn(
        'id',
        trx('pod_membership').where({ memberType: 'fact', memberId: fact.id }).select('podId'),
      )
      .where('memberFactCount', '>', 0)
      .decrement('memberFactCount', 1);
    await trx('pod_membership').where({ memberType: 'fact', memberId: fact.id }).del();

    // 4. Finally remove the fact itself.
    await trx('fact').where({ id: fact.id }).del();
  });

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
  prepareFactBatch,
  applyPreparedFactBatch,
  audmDecideBatch,
  cosineSimilarity,
  insertFact,
  findByUid,
  listFacts,
  listByCategory,
  listByDocument,
  countActiveByDocuments,
  markContradicted,
  markSuperseded,
  supersedeStaleDocFacts,
  findSimilar,
  recordAccess,
  getHotFacts,
  getFactCount,
  deleteFact,
  setFactVisibility,
  listNamespaces,
  deleteNamespace,
};
