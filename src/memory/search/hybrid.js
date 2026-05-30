import { keyBy } from '../../lib/collection.js';

import { embed, embedBatch } from '../../ingestion/embedder.js';
import config from '../../config.js';
import { findByName, searchByName } from '../entities/store.js';
import { getFactsForEntity } from '../facts/entity-linker.js';
import { recordAccess } from '../facts/store.js';
import { strengthenEdges } from '../lifecycle/hebbian.js';
import { strengthenEntityEdges, getEdgeStrengthsForRanking } from '../lifecycle/entity-hebbian.js';
import { listRelationsForEntity } from '../entities/relations.js';
import { getEntityIdsForFacts } from '../facts/entity-linker.js';
import * as vectorSearch from './vector.js';
import * as keywordSearch from './keyword.js';
import { hybridSearchFacts } from './hybrid-sql.js';
import { extractEntitiesFromFacts, findRelatedFacts, rerank } from './graph-enhancement.js';
import { expandQuery } from './query-expander.js';
import { routeQuery } from '../cognitive/query-router.js';
import { prompt as llmPrompt } from '../../lib/llm.js';
import '../pods/kinds/index.js'; // side-effect: register built-in kinds
import { activeKinds } from '../pods/registry.js';
import cortexDb from '../../db/cortex.js';

// K=20 gives good score spread for our result set sizes (5-50).
// K=60 (original paper) compresses scores into a ~0.001 band with small sets.
const RRF_K = 20;

// Vector results get higher weight — better for semantic/natural language queries.
const VECTOR_WEIGHT = 1.0;
const KEYWORD_WEIGHT = 0.7;

// Entity detection only for short, name-like queries — not full sentences
const MAX_ENTITY_QUERY_LENGTH = 60;

async function search(query, { namespaces, limit = 5, minConfidence = 'medium', useGraph = false, includeChunks = false, pointInTime, expand = false, route = true, categories, synthesize = config.search.synthesize, podScope = null, applyFloor = true, ctx = {} } = {}) {
  const _t0 = Date.now();
  if (!isSearchableQuery(query)) {
    const empty = emptySearchResult();
    empty._trace = { query, searchable: false, stages: [{ stage: 'guard', note: 'query is not searchable (empty or wildcard-only)' }], durationMs: Date.now() - _t0 };
    return empty;
  }

  // When synthesis is on, force include chunks so the synthesizer has raw material
  // (especially important in lazy/Ogham mode where no facts are stored).
  if (synthesize) includeChunks = true;

  // Cognitive routing — classify query intent and adjust search params
  let routing = null;
  if (route) {
    routing = await routeQuery(query);
    // Route decision is logged to llm_log via the router's promptJson call.
    // No console output here — search is called from MCP/hooks where stdout is protocol.

    useGraph = useGraph || routing.useGraph;
    expand = expand || routing.expand;
    limit = routing.limit || limit;
    pointInTime = pointInTime || routing.pointInTime;
    categories = categories || (routing.categories.length ? routing.categories : undefined);
  }

  const matchedEntity = await detectEntity(query, namespaces);

  const podIds = await resolvePodScope(podScope, { ...ctx, namespace: namespaces?.[0] });

  let result;
  if (matchedEntity) {
    result = await entityFirstSearch(matchedEntity, query, { namespaces, limit, minConfidence, includeChunks, pointInTime, categories, podIds });
  } else {
    result = await standardSearch(query, { namespaces, limit, minConfidence, useGraph, includeChunks, pointInTime, expand, categories, podIds });
  }

  // Precision-first relevance floor. For auto-injection paths (hooks /
  // hot-context, applyFloor=true) drop facts whose absolute cosine similarity
  // is below config.memory.injectionFloor — better to inject nothing than
  // something off-topic. Entity-matched facts (source='entity') and facts with
  // no similarity score are exempt: they earned inclusion by name match, not
  // semantic distance. The floor runs BEFORE access-tracking/Hebbian so dropped
  // facts aren't reinforced (which would keep boosting off-topic facts via
  // ACT-R). Explicit human search passes applyFloor:false to see everything.
  let floored = null;
  if (applyFloor && Array.isArray(result.facts) && result.facts.length) {
    const threshold = config.memory.injectionFloor;
    const before = result.facts.length;
    result.facts = result.facts.filter((f) => {
      if (f.source === 'entity') return true;
      const sim = Number(f.similarity);
      if (!Number.isFinite(sim)) return true;
      return sim >= threshold;
    });
    floored = { threshold, dropped: before - result.facts.length, kept: result.facts.length };
  }

  // Fire-and-forget access tracking + Hebbian co-retrieval edge strengthening.
  // Both run off the hot path (no await). Edge writes are O(K²) per query but K is
  // small (default top-5), so it's tens of upserts at most. Per Ogham §G.
  const factIds = result.facts.map((f) => f.id).filter(Boolean);
  recordAccess(factIds).catch((err) => console.error('[access-tracking]', err.message));
  strengthenEdges(factIds.slice(0, 8)).catch((err) => console.error('[hebbian]', err.message));

  // Entity-level Hebbian: strengthen edges between every entity linked to a
  // top-K fact. Survives paraphrase + AUDM splits in a way fact-level cannot.
  if (config.hebbian.entity.enabled && factIds.length >= 2) {
    strengthenEntitiesForResult(factIds).catch((err) => console.error('[hebbian-entity]', err.message));
  }

  // Read-time synthesis — LLM pass over retrieved evidence to compose a coherent answer.
  // The synthesizer is also the must-miss signal: it returns "Not in retrieved memory."
  // when the top-K doesn't actually contain the answer, which is more reliable than any
  // similarity threshold.
  if (synthesize) {
    try {
      result.synthesized = await synthesizeAnswer(query, result);
    } catch (err) {
      console.error('[synthesizer] failed:', err.message);
      result.synthesized = null;
    }
  }

  result._trace = buildSearchTrace({
    query, namespaces, limit, minConfidence, useGraph, expand, route,
    routing, matchedEntity, podScope, podIds, result, factIds, floored,
    durationMs: Date.now() - _t0,
  });

  return result;
}

// Assemble the full causal trace for a search: the routing decision, whether
// an entity short-circuit fired, the resolved pod scope, and every ranked
// fact/chunk with the scores that placed it there — cosine similarity, the
// RRF fusion score, the ACT-R activation (frequency + recency decay), the
// importance/confidence multipliers' net effect (final_score), the
// post-merge normalized rrfScore, and any entity co-retrieval boost.
function buildSearchTrace({ query, namespaces, limit, minConfidence, useGraph, expand, route, routing, matchedEntity, podScope, podIds, result, factIds, floored, durationMs }) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : null; };

  const rankedFacts = (result.facts || []).map((f, i) => ({
    rank: i + 1,
    id: f.id ?? null,
    content: String(f.content || '').slice(0, 240),
    category: f.category ?? null,
    importance: f.importance ?? null,
    confidence: f.confidence ?? null,
    source: f.source ?? null,                 // 'entity' | 'search'
    similarity: num(f.similarity),            // cosine (vector)
    rrfRaw: num(f.rrf_raw),                    // RRF fusion (vector+keyword)
    activation: num(f.activation),             // ACT-R: ln(uses+1) − 0.5·ln(t_days) → decay/frequency
    accessCount: f.access_count ?? null,
    lastAccessedAt: f.lastAccessedAt ?? null,
    finalScore: num(f.final_score),            // rrf × activation × importance × confidence
    rrfScore: num(f.rrfScore),                 // normalized score the ranker sorted on
    coRetrievalBoost: num(f.coRetrievalBoost), // entity-Hebbian bump, if any
  }));

  const rankedChunks = (result.chunks || []).map((c, i) => ({
    rank: i + 1,
    id: c.id ?? null,
    sectionHeading: c.sectionHeading ?? null,
    content: String(c.content || '').slice(0, 200),
    similarity: num(c.similarity),
    rrfScore: num(c.rrfScore),
  }));

  return {
    query,
    namespaces,
    durationMs,
    params: { limit, minConfidence, useGraphRequested: useGraph, expandRequested: expand, routeEnabled: route },
    routing: routing
      ? {
          intent: routing.intent ?? null,
          reasoning: routing.reasoning ?? null,
          useGraph: routing.useGraph ?? null,
          expand: routing.expand ?? null,
          limit: routing.limit ?? null,
          categories: routing.categories ?? null,
          pointInTime: routing.pointInTime ?? null,
        }
      : null,
    strategy: matchedEntity ? 'entity-first' : 'standard',
    matchedEntity: matchedEntity
      ? { id: matchedEntity.id, name: matchedEntity.name, type: matchedEntity.entityType, aliases: matchedEntity.aliases || [] }
      : null,
    podScope: { requested: podScope, resolvedIds: podIds },
    floor: floored
      ? { applied: true, threshold: floored.threshold, dropped: floored.dropped, kept: floored.kept, note: 'precision-first: facts below cosine floor dropped from injection' }
      : { applied: false },
    ranking: {
      model: 'RRF(vector×1.0 + keyword×0.7) × softplus(ACT-R activation) × importance × confidence',
      facts: rankedFacts,
      chunks: rankedChunks,
    },
    synthesized: result.synthesized || null,
    relatedEntities: result.relatedEntities || [],
    reinforced: { factIds, note: 'access_count bumped + Hebbian co-retrieval edges strengthened (off hot path)' },
  };
}

function isSearchableQuery(query) {
  const q = String(query || '').trim();
  if (!q) return false;
  return !/^[*%_?\s]+$/.test(q);
}

function emptySearchResult() {
  return {
    facts: [],
    chunks: [],
    matchedEntity: null,
    relatedEntities: [],
  };
}

async function synthesizeAnswer(query, { facts, chunks }) {
  const evidence = [];

  facts.slice(0, 10).forEach((f, i) => {
    evidence.push(`[F${i + 1}] (${f.category}) ${f.content}`);
  });

  if (chunks.length) {
    // Up to 15 chunks at 2000 char each. Modern context windows handle this fine
    // and the prior 5×600 was starving temporal/compositional questions.
    chunks.slice(0, 15).forEach((c, i) => {
      const text = (c.content || '').replace(/\s+/g, ' ').trim();
      if (text) evidence.push(`[C${i + 1}] ${text.slice(0, 2000)}`);
    });
  }

  if (!evidence.length) return 'No retrieved evidence — nothing to synthesize.';

  const synthPrompt = `You are answering a question from a personal-memory system.
Each retrieved item is labeled [F#] (a stored fact) or [C#] (a raw conversation chunk
that may include user/assistant turns and dates).

Question: ${query}

Retrieved memory items:
${evidence.join('\n')}

Instructions:
- Read the chunks carefully — the answer is often a specific phrase or date inside one of them, not always pre-summarized as a fact.
- Reason step-by-step internally for temporal questions ("first", "before", "after", "how many days") — compare the dates explicitly.
- Cite items in square brackets where they directly support the answer, e.g. [C2].
- Only respond "Not in retrieved memory." if you genuinely cannot find the information after carefully reading every chunk. Prefer a careful answer with citation over refusal.
- Plain text only, no headers. Direct answer first, then a short justification if needed. 1-4 sentences total.`;

  const model = config.search.synthesizeModel || config.llm.extractionModel || undefined;
  return llmPrompt(synthPrompt, { model, caller: 'synthesizer' });
}

// Resolve entities for the top-K facts and strengthen their pairwise edges.
// Capped at config.hebbian.entity.maxWriteEntities to keep the O(K²) upsert
// volume bounded even on large result sets.
async function strengthenEntitiesForResult(factIds) {
  const map = await getEntityIdsForFacts(factIds.slice(0, 8));
  const entityIds = [];
  for (const ids of map.values()) {
    for (const id of ids) entityIds.push(id);
  }
  const unique = [...new Set(entityIds)].slice(0, config.hebbian.entity.maxWriteEntities);
  await strengthenEntityEdges(unique);
}

// Resolve a podScope value into numeric pod IDs for the SQL filter.
//
//   null | undefined | 'global'  → null (no filter, full brain)
//   'auto'                       → IDs for pods returned by
//                                   registry.activeKinds(ctx); skips
//                                   virtual sentinels (vital).
//   string[]                     → mix of pod uids ('pod-...') and pod
//                                   names; both resolved against pod table.
//   number[]                     → passed through unchanged.
//
// Returns [] when scoping was requested but resolves to nothing — SQL
// treats that as "no pods match" rather than "no filter" (correct: an
// agent that has zero readable pods should see zero facts).
async function resolvePodScope(podScope, ctx = {}) {
  if (podScope == null || podScope === 'global') return null;

  if (podScope === 'auto') {
    const active = await activeKinds(ctx);
    const uids = active
      .flatMap((a) => a.scope)
      .filter((u) => typeof u === 'string' && !u.startsWith('__virtual:'));
    if (uids.length === 0) {
      // Scope was requested but nothing is active. Distinguish a genuine fresh
      // install (no pods at all → grace to global so day-one users still get
      // memory; the relevance floor still applies, so it's global-but-floored,
      // NOT the old global dump) from an established user in an unpod'd context
      // (scope to nothing — precision-first, no cross-project leak). Disable
      // the grace with SIGIL_SCOPE_GRACE=false.
      if (process.env.SIGIL_SCOPE_GRACE !== 'false') {
        let q = cortexDb('pod');
        if (ctx.namespace) q = q.where({ namespace: ctx.namespace });
        const [{ count }] = await q.count({ count: '*' });
        if (Number(count) === 0) return null;
      }
      return [];
    }
    const rows = await cortexDb('pod').whereIn('uid', uids).select('id');
    return rows.map((r) => r.id);
  }

  if (Array.isArray(podScope)) {
    if (podScope.length === 0) return [];
    if (podScope.every((x) => typeof x === 'number')) return podScope;
    const strings = podScope.filter((x) => typeof x === 'string');
    if (strings.length === 0) return [];
    const rows = await cortexDb('pod')
      .where(function () {
        this.whereIn('uid', strings).orWhereIn('name', strings);
      })
      .select('id');
    return rows.map((r) => r.id);
  }

  return null;
}

// Check if the query matches a known entity by name (DB lookup, no LLM call)
async function detectEntity(query, namespaces) {
  if (query.length < 2 || query.length > MAX_ENTITY_QUERY_LENGTH) return null;

  const ns = namespaces[0] || config.defaults.namespace;

  // Exact case-insensitive match first
  const exact = await findByName(query, ns);
  if (exact) return exact;

  // Fuzzy LIKE match — top result only
  const results = await searchByName(query, { namespace: ns, limit: 1 });
  return results[0] || null;
}

// Entity detected: fetch entity facts + relations in parallel with hybrid
// search across the canonical name + every alias, then merge.
//
// This is the bridge across renames. When the user asks "Sigil" and the
// canonical entity has aliases=["smara"], the original cosine/keyword
// search for "Sigil" can't see fact text that still says "Smara." Running
// a parallel search for each alias and merging the result sets lets those
// historical facts surface — without rewriting fact text.
async function entityFirstSearch(entity, query, { namespaces, limit, minConfidence, includeChunks, pointInTime, categories, podIds }) {
  const queryVariants = buildAliasQueryVariants(query, entity);

  const variantEmbeddings = await embedBatch(queryVariants, { inputType: 'query' });

  const [entityFacts, entityRelations, ...hybridResults] = await Promise.all([
    getFactsForEntity(entity.id, { limit }),
    listRelationsForEntity(entity.id, { limit: 15 }),
    ...queryVariants.map((q, i) => coreHybridSearch(q, {
      queryEmbedding: variantEmbeddings[i],
      namespaces, limit, minConfidence, includeChunks, pointInTime, categories, podIds,
    })),
  ]);

  // Entity-linked facts get highest priority
  const entityFactsMarked = entityFacts.map((f) => ({ ...f, source: 'entity' }));

  // Merge facts across all query variants (canonical + each alias) by RRF.
  // multiQueryMerge already handles inter-variant ranking — duplicates the
  // same fact across variants accumulate score, which is what we want for
  // facts that match multiple alias forms.
  const mergedHybridFacts = multiQueryMerge(hybridResults.map((r) => r.facts), limit * 2);

  // Then dedupe the merged hybrid set against the entity-linked facts so
  // facts already pulled by entity_id don't get listed twice.
  const seenIds = new Set(entityFactsMarked.map((f) => f.id));
  const hybridExtra = mergedHybridFacts
    .filter((f) => !seenIds.has(f.id))
    .map((f) => ({ ...f, source: 'search' }));

  let facts = [...entityFactsMarked, ...hybridExtra].slice(0, limit);

  // Entity-Hebbian boost with the matched entity as the explicit seed.
  // Facts linked to entities co-retrieved with the matched entity get
  // promoted within the result set.
  if (config.hebbian.entity.enabled && facts.length >= 2) {
    try {
      facts = await applyCoRetrievalBoost(facts, { seedEntityIds: [entity.id] });
    } catch (err) {
      console.error('[hebbian-entity-boost]', err.message);
    }
  }

  // Same merge for chunks (chunks aren't entity-linked, so this is the
  // ONLY way historical-name chunks surface for a renamed query).
  const chunks = includeChunks
    ? multiQueryMerge(hybridResults.map((r) => r.chunks || []), limit)
    : [];

  const relatedEntities = entityRelations.map((r) => ({
    id: r.entityId,
    name: r.name,
    type: r.entityType,
    relation: r.relationType,
    direction: r.direction,
    mentions: r.mentionCount,
  }));

  return {
    facts,
    chunks,
    matchedEntity: {
      id: entity.id,
      name: entity.name,
      type: entity.entityType,
      mentions: entity.mentionCount,
      description: entity.description || null,
      aliases: entity.aliases || [],
    },
    relatedEntities,
  };
}

// Generate query variants by substituting the canonical entity name with
// each alias. If the original query doesn't contain the canonical name as
// a word (e.g. user typed an alias directly), fall back to running a
// search for the alias as-is so chunks/facts using either form still
// surface.
//
// Original  : "What did we decide about Sigil?"
// Variants  : ["What did we decide about Sigil?", "What did we decide about smara?"]
//
// Original  : "Smara"   (alias typed directly; entity has canonical name "Sigil")
// Variants  : ["Smara"]   — no canonical-name occurrence to substitute, but the
//                          query already matches the alias, so the original is fine.
function buildAliasQueryVariants(query, entity) {
  const variants = [query];
  const aliases = (entity.aliases || []).filter((a) => typeof a === 'string' && a.trim());
  if (!aliases.length) return variants;

  const canonical = (entity.name || '').trim();
  const seen = new Set([query.toLowerCase()]);

  for (const alias of aliases) {
    let v = query;
    if (canonical) {
      const re = new RegExp(`\\b${escapeRegex(canonical)}\\b`, 'gi');
      if (re.test(v)) {
        v = v.replace(re, alias);
      } else {
        // No canonical occurrence to replace — also include the alias as
        // a bare query so vector/keyword can hit historical text.
        if (!seen.has(alias.toLowerCase())) {
          variants.push(alias);
          seen.add(alias.toLowerCase());
        }
        continue;
      }
    }
    if (!seen.has(v.toLowerCase())) {
      variants.push(v);
      seen.add(v.toLowerCase());
    }
  }

  return variants;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// No entity match: expand query into variants, search all in parallel, merge
async function standardSearch(query, { namespaces, limit, minConfidence, useGraph, includeChunks, pointInTime, expand = false, categories, podIds }) {
  const queries = expand ? await expandQuery(query) : [query];
  const embeddings = await embedBatch(queries, { inputType: 'query' });

  const results = await Promise.all(
    queries.map((q, i) => coreHybridSearch(q, { queryEmbedding: embeddings[i], namespaces, limit, minConfidence, includeChunks, pointInTime, categories, podIds })),
  );

  let facts = multiQueryMerge(results.map((r) => r.facts), limit);
  facts = facts.map((f) => ({ ...f, source: 'search' }));

  // Third signal: entity-Hebbian co-retrieval boost. Seed = entities of the
  // current top hits; candidates = entities of the rest. Facts whose entities
  // are tightly co-retrieved with the seed get a normalized score bump.
  if (config.hebbian.entity.enabled && facts.length >= 2) {
    try {
      facts = await applyCoRetrievalBoost(facts);
    } catch (err) {
      console.error('[hebbian-entity-boost]', err.message);
    }
  }

  if (useGraph && facts.length) {
    try {
      const mentionedEntities = await extractEntitiesFromFacts(facts.slice(0, 5));
      if (mentionedEntities.length) {
        // Expand the seed entity set with their top co-retrieved neighbors so
        // findRelatedFacts can pull in facts linked to associatively-linked
        // entities, not just relation-linked ones.
        const expandedIds = await expandWithCoRetrievedEntities(mentionedEntities.map((e) => e.id));
        const relatedFacts = await findRelatedFacts(expandedIds, { limit: 5 });
        facts = rerank(facts, relatedFacts, expandedIds, limit);
      }
    } catch (err) {
      console.error('[graph-enhancement] Failed:', err.message);
    }
  }

  const chunks = includeChunks
    ? multiQueryMerge(results.map((r) => r.chunks), limit)
    : [];

  return {
    facts,
    chunks,
    matchedEntity: null,
    relatedEntities: [],
  };
}

// Compute the per-fact co-retrieval boost and fold it into rrfScore.
// Seed = top-3 facts' linked entities (what the search seems to be about).
// Candidate = entities of every other fact in the result set.
// Each candidate fact's boost = max strength across its linked entities,
// normalized against the strongest boost in this result set, then weighted by
// config.hebbian.entity.rrfWeight before being added to rrfScore.
async function applyCoRetrievalBoost(facts, opts = {}) {
  const factIds = facts.map((f) => f.id).filter(Boolean);
  if (factIds.length < 2) return facts;

  const factEntityMap = await getEntityIdsForFacts(factIds);
  if (!factEntityMap.size) return facts;

  let seedEntityIds;
  let candidateFacts;
  if (opts.seedEntityIds?.length) {
    // Explicit seed (entity-first search uses the matched entity as seed).
    seedEntityIds = opts.seedEntityIds;
    candidateFacts = facts;
  } else {
    // Auto-seed from top-N facts' linked entities.
    const seedFactCount = opts.seedFactCount ?? 3;
    const auto = [];
    for (const f of facts.slice(0, seedFactCount)) {
      const ids = factEntityMap.get(f.id) || [];
      for (const id of ids) auto.push(id);
    }
    seedEntityIds = auto;
    candidateFacts = facts.slice(seedFactCount);
  }
  if (!seedEntityIds.length) return facts;

  const candidateEntityIds = new Set();
  for (const f of candidateFacts) {
    const ids = factEntityMap.get(f.id) || [];
    for (const id of ids) candidateEntityIds.add(id);
  }
  if (!candidateEntityIds.size) return facts;

  const strengths = await getEdgeStrengthsForRanking([...new Set(seedEntityIds)], [...candidateEntityIds]);
  if (!strengths.size) return facts;

  const factBoost = new Map();
  let maxBoost = 0;
  for (const f of facts) {
    const ids = factEntityMap.get(f.id) || [];
    let boost = 0;
    for (const id of ids) {
      const s = strengths.get(id) || 0;
      if (s > boost) boost = s;
    }
    factBoost.set(f.id, boost);
    if (boost > maxBoost) maxBoost = boost;
  }
  if (maxBoost === 0) return facts;

  const weight = config.hebbian.entity.rrfWeight;
  const boosted = facts.map((f) => {
    const normalized = (factBoost.get(f.id) || 0) / maxBoost;
    const newScore = (f.rrfScore || 0) + weight * normalized;
    return {
      ...f,
      rrfScore: Math.round(newScore * 100) / 100,
      coRetrievalBoost: Math.round(normalized * 100) / 100,
    };
  });

  return boosted.sort((a, b) => (b.rrfScore || 0) - (a.rrfScore || 0));
}

// Expand a set of seed entity IDs with their top decayed co-retrieval
// neighbors. Returns a unique-ID list (seeds first, then neighbors).
async function expandWithCoRetrievedEntities(seedEntityIds) {
  const perSeed = config.hebbian.entity.expandPerSeed;
  if (!perSeed || !seedEntityIds.length) return seedEntityIds;

  const { getCoRetrievedEntities } = await import('../lifecycle/entity-hebbian.js');
  const neighborLists = await Promise.all(
    seedEntityIds.map((id) => getCoRetrievedEntities(id, { limit: perSeed }).catch(() => [])),
  );

  const expanded = new Set(seedEntityIds);
  for (const list of neighborLists) {
    for (const row of list) expanded.add(Number(row.partnerId));
  }
  return [...expanded];
}

// Merge results from multiple query variants using RRF
function multiQueryMerge(resultSets, limit) {
  const scores = {};
  const itemsById = {};

  for (const results of resultSets) {
    for (const [rank, item] of results.entries()) {
      itemsById[item.id] = item;
      scores[item.id] = (scores[item.id] || 0) + 1 / (RRF_K + rank + 1);
    }
  }

  const entries = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const maxScore = entries.length ? entries[0][1] : 1;

  return entries
    .slice(0, limit)
    .map(([id, score]) => ({
      ...itemsById[id],
      rrfScore: Math.round((score / maxScore) * 100) / 100,
    }));
}

// Core vector+keyword hybrid with RRF merge.
// Facts use single-SQL-query RRF (see hybrid-sql.js). Chunks stay on the
// two-query + JS-merge path since they have no category/confidence filters.
async function coreHybridSearch(query, { queryEmbedding: precomputed, namespaces, limit, minConfidence, includeChunks = false, pointInTime, categories, podIds }) {
  const queryEmbedding = precomputed || await embed(query, { inputType: 'query' });

  const factsPromise = hybridSearchFacts(query, queryEmbedding, {
    namespaces, limit, minConfidence, pointInTime, categories, podIds,
  });

  const chunkPromises = includeChunks
    ? [
        vectorSearch.searchChunks(queryEmbedding, { namespaces, limit }),
        keywordSearch.searchChunks(query, { namespaces, limit }),
      ]
    : [];

  const [facts, ...chunkResults] = await Promise.all([factsPromise, ...chunkPromises]);

  const chunks = includeChunks && chunkResults.length === 2
    ? rrfMerge(chunkResults[0], chunkResults[1], limit)
    : [];

  return { facts, chunks };
}

function rrfMerge(vectorResults, keywordResults, limit) {
  const scores = {};
  const itemsById = {
    ...keyBy(vectorResults, 'id'),
    ...keyBy(keywordResults, 'id'),
  };

  vectorResults.forEach((item, rank) => {
    scores[item.id] = (scores[item.id] || 0) + VECTOR_WEIGHT / (RRF_K + rank + 1);
  });

  keywordResults.forEach((item, rank) => {
    scores[item.id] = (scores[item.id] || 0) + KEYWORD_WEIGHT / (RRF_K + rank + 1);
  });

  // Normalize scores to 0-1 range, with vital facts sorted before supplementary at same score
  const entries = Object.entries(scores).sort(([idA, a], [idB, b]) => {
    if (a !== b) return b - a;
    const importanceA = itemsById[idA]?.importance === 'vital' ? 1 : 0;
    const importanceB = itemsById[idB]?.importance === 'vital' ? 1 : 0;
    return importanceB - importanceA;
  });
  const maxScore = entries.length ? entries[0][1] : 1;

  return entries
    .slice(0, limit)
    .map(([id, score]) => ({
      ...itemsById[id],
      rrfScore: Math.round((score / maxScore) * 100) / 100,
    }));
}

export { search, isSearchableQuery };
