/**
 * Algorithmic relation candidates — the cheap half of edge building.
 *
 * Today every edge comes from one LLM call per ingest, over one batch of facts.
 * That has two structural problems that no amount of prompt work fixes:
 *
 *   1. The model only ever sees the batch in front of it, so a fact ingested
 *      today cannot relate to an entity stored last week.
 *   2. graph-extractor's resolveEndpoint then drops any proposed endpoint whose
 *      name is not verbatim in that batch's text, pruning valid edges.
 *
 * Measured on a real store: 123 entity pairs share at least one fact, and 58 of
 * them (47%) have no typed relation. That signal is already in `fact_entity` —
 * it costs a self-join, not a model call.
 *
 * This module does candidate generation and RANKING only. It deliberately does
 * not invent predicates: co-occurrence proves association, not direction or
 * meaning ("anmol" and "asd-ste100" appear together; only semantics say the
 * edge is PREFERS). Naming stays an LLM job — but a batched one over a short,
 * high-precision list instead of open-ended discovery over prose.
 *
 * Ranking is PMI (pointwise mutual information):
 *
 *     pmi(a,b) = log( p(a,b) / (p(a) · p(b)) )
 *
 * Raw co-occurrence counts are the wrong sort order: two hub entities share
 * facts constantly and mean little by it, while two rare entities appearing
 * together is a strong signal. Every term is a count already in the table.
 */
import cortexDb from '../../db/cortex.js';

/**
 * Co-occurring entity pairs that have no typed relation yet, ranked by PMI.
 *
 * `minShared` is the floor on how many facts a pair must share. 1 is the honest
 * default on a small store — most real pairs only ever co-occur once — but it
 * admits more noise, which is why PMI does the sorting rather than the count.
 *
 * Pure read. Returns rows, writes nothing.
 */
export async function deriveCandidates({
  namespace = null,
  minShared = 1,
  limit = 50,
  includeExisting = false,
} = {}) {
  const params = [];
  let nsFilter = '';
  if (namespace) {
    params.push(namespace);
    nsFilter = `AND f.namespace = ?`;
  }

  // One pass: pair counts, per-entity totals, and the grand total, then PMI.
  // Kept as a single statement so the counts can never drift between queries.
  const sql = `
    WITH linked AS (
      SELECT fe.fact_id, fe.entity_id
      FROM fact_entity fe
      JOIN fact f ON f.id = fe.fact_id AND f.status = 'active' ${nsFilter}
      JOIN entity e ON e.id = fe.entity_id AND e.merged_with IS NULL
      GROUP BY fe.fact_id, fe.entity_id
    ),
    pairs AS (
      SELECT a.entity_id AS x, b.entity_id AS y, COUNT(*)::float AS shared
      FROM linked a
      JOIN linked b ON a.fact_id = b.fact_id AND a.entity_id < b.entity_id
      GROUP BY 1, 2
    ),
    totals AS (SELECT entity_id, COUNT(*)::float AS n FROM linked GROUP BY 1),
    grand AS (SELECT COUNT(DISTINCT fact_id)::float AS n FROM linked)
    SELECT
      p.x, p.y, p.shared,
      ex.name AS x_name, ex.entity_type AS x_type,
      ey.name AS y_name, ey.entity_type AS y_type,
      tx.n AS x_facts, ty.n AS y_facts, g.n AS total_facts,
      ln( (p.shared / g.n) / ((tx.n / g.n) * (ty.n / g.n)) ) AS pmi,
      EXISTS (
        SELECT 1 FROM relation r
        WHERE (r.source_id = p.x AND r.target_id = p.y)
           OR (r.source_id = p.y AND r.target_id = p.x)
      ) AS has_relation
    FROM pairs p
    JOIN totals tx ON tx.entity_id = p.x
    JOIN totals ty ON ty.entity_id = p.y
    JOIN entity ex ON ex.id = p.x
    JOIN entity ey ON ey.id = p.y
    CROSS JOIN grand g
    WHERE p.shared >= ?
    ORDER BY pmi DESC, p.shared DESC
  `;
  params.push(minShared);

  const { rows } = await cortexDb.raw(sql, params);
  const all = rows.map((r) => ({
    sourceId: r.x,
    targetId: r.y,
    sourceName: r.x_name,
    sourceType: r.x_type,
    targetName: r.y_name,
    targetType: r.y_type,
    sharedFacts: Number(r.shared),
    sourceFacts: Number(r.x_facts),
    targetFacts: Number(r.y_facts),
    pmi: Number(r.pmi),
    hasRelation: Boolean(r.has_relation),
  }));

  const candidates = includeExisting ? all : all.filter((c) => !c.hasRelation);
  return {
    totalPairs: all.length,
    alreadyRelated: all.filter((c) => c.hasRelation).length,
    candidates: candidates.slice(0, limit),
    returned: Math.min(candidates.length, limit),
    unresolved: candidates.length,
  };
}

/**
 * The facts a candidate pair actually shares — the evidence a namer needs.
 * Fetched in one query for the whole batch rather than per pair.
 */
export async function evidenceFor(pairs, { perPair = 2 } = {}) {
  if (!pairs.length) return new Map();
  const ids = [...new Set(pairs.flatMap((p) => [p.sourceId, p.targetId]))];
  const { rows } = await cortexDb.raw(
    `SELECT a.entity_id x, b.entity_id y, f.content
     FROM fact_entity a
     JOIN fact_entity b ON a.fact_id = b.fact_id AND a.entity_id < b.entity_id
     JOIN fact f ON f.id = a.fact_id AND f.status = 'active'
     WHERE a.entity_id = ANY(?) AND b.entity_id = ANY(?)`,
    [ids, ids],
  );
  const out = new Map();
  for (const r of rows) {
    const k = `${r.x}:${r.y}`;
    const list = out.get(k) || [];
    if (list.length < perPair) list.push(r.content);
    out.set(k, list);
  }
  return out;
}

/**
 * Name the predicates for a batch of candidate pairs in ONE call.
 *
 * The saving is structural, not prompt tuning. graph-extractor asks a model to
 * DISCOVER and NAME relations from raw prose on every ingest; here discovery
 * already happened in SQL, so the model gets a closed list of resolved entity
 * pairs plus the sentence that links them, and answers a much smaller question.
 * `none` is a first-class answer — co-occurrence proves association, and the
 * model's job is partly to reject the pairs where that is all it is.
 */
export function buildNamingPrompt(pairs, evidence) {
  const lines = pairs.map((p, i) => {
    const ev = (evidence.get(`${p.sourceId}:${p.targetId}`) || [])
      .map((c) => `      evidence: ${c.slice(0, 200)}`).join('\n');
    return `  ${i + 1}. "${p.sourceName}" ‹—› "${p.targetName}"\n${ev}`;
  }).join('\n');

  return `These entity pairs each appear together in the same stored fact. Co-occurrence is NOT a relationship — two things mentioned in one sentence are often merely both present. Your job is to separate the pairs that assert a real relationship from the pairs that do not.

For each numbered pair return:
  - "relationship": a short lowercase verb phrase the evidence STATES or directly implies ("uses", "part of", "prefers", "replaces", "syncs with"), or the exact string "none".
  - "direction": "forward" if it reads subject→object as listed, "reverse" if the true subject is the second entity.
  - "confidence": "high" when the evidence states it outright, "low" when you are inferring.

Return "none" when:
  - the evidence just lists both things, or mentions them in the same breath;
  - the only link you can name is vague ("relates to", "differs from", "variant of", "associated with");
  - the two are siblings in a list or alternatives of the same kind, rather than one acting on the other;
  - you would have to reach outside the evidence to justify it.

A vague verb is worse than "none" — it puts a wrong edge in a knowledge graph that ranking later trusts. Expect to reject a good share of these; rejecting is the correct answer far more often than it feels.

Pairs:
${lines}

Respond with ONLY a JSON object: {"relations":[{"n":1,"relationship":"uses","direction":"forward","confidence":"high"}, ...]} — one entry per numbered pair, in order.`;
}

/**
 * Name a candidate set with bounded parallelism.
 *
 * Batch size is a latency decision, not a quality one. Measured on 31 real
 * candidates: one call for all 31 took 324.7s, four parallel calls of 8 took
 * 84.5s wall clock for the same verdicts (25 named vs 24). The model reasons
 * about each pair regardless, so splitting converts serial thinking into
 * concurrent thinking.
 *
 * Never put this on the write path. Even at 84s it is a maintenance job; the
 * point of doing discovery in SQL is that ingest no longer waits for any of it.
 */
export async function nameCandidates(candidates, { promptJson, batchSize = 8, caller = 'relation-namer' } = {}) {
  if (!candidates.length) return [];
  const evidence = await evidenceFor(candidates);
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));

  const results = await Promise.all(batches.map((batch) =>
    promptJson(buildNamingPrompt(batch, evidence), { caller })
      .then((r) => ({ batch, rels: (r && r.relations) || [] }))
      // One bad batch must not lose the rest — this runs unattended.
      .catch(() => ({ batch, rels: [] }))));

  const out = [];
  for (const { batch, rels } of results) {
    batch.forEach((c, i) => {
      const r = rels.find((x) => Number(x.n) === i + 1);
      if (!r || !r.relationship || r.relationship === 'none') return;
      const reverse = r.direction === 'reverse';
      out.push({
        ...c,
        sourceId: reverse ? c.targetId : c.sourceId,
        targetId: reverse ? c.sourceId : c.targetId,
        sourceName: reverse ? c.targetName : c.sourceName,
        targetName: reverse ? c.sourceName : c.targetName,
        relationship: r.relationship,
        confidence: r.confidence || 'medium',
      });
    });
  }
  return out;
}
