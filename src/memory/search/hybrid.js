/**
 * Deterministic retrieval core.
 *
 * One query embedding feeds vector + keyword retrieval. Facts are fused in one
 * SQL round-trip; optional document chunks use the same RRF policy in memory.
 * No routing LLM, synthesis, graph traversal, entity detection, pod resolution,
 * lifecycle mutation, or learned-edge feedback belongs in this path.
 */
import { keyBy } from '../../lib/collection.js';
import { embed } from '../../ingestion/embedder.js';
import config from '../../config.js';
import { RRF_K, VECTOR_WEIGHT, KEYWORD_WEIGHT } from './scoring-constants.js';
import * as vectorSearch from './vector.js';
import * as keywordSearch from './keyword.js';
import { hybridSearchFacts } from './hybrid-sql.js';

export async function search(query, {
  namespaces = [config.defaults.namespace],
  namespaceTiers,
  limit = 5,
  minConfidence = 'medium',
  includeChunks = false,
  pointInTime,
  categories,
  applyFloor = true,
} = {}) {
  const startedAt = Date.now();
  if (!isSearchableQuery(query)) {
    return {
      ...emptySearchResult(),
      _trace: {
        query,
        searchable: false,
        stages: [{ stage: 'guard', note: 'empty or wildcard-only query' }],
        durationMs: Date.now() - startedAt,
      },
    };
  }

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 5));
  const tiers = normalizeNamespaceTiers(namespaceTiers, namespaces);
  const searchedNamespaces = tiers.flat();
  const queryEmbedding = await embed(query, { inputType: 'query' });
  // Search each tier separately so a decision in the active project cannot be
  // outranked by a merely more similar fact from the user's shared history.
  // The query is embedded once; the extra database read is only for a Git
  // project and keeps the ranking rule explicit and explainable.
  const [rawFacts, chunks] = await Promise.all([
    searchFactTiers(query, queryEmbedding, tiers, {
      limit: safeLimit, minConfidence, pointInTime, categories, applyFloor,
    }),
    includeChunks
      ? searchChunkTiers(query, queryEmbedding, tiers, safeLimit)
      : Promise.resolve([]),
  ]);
  let facts = rawFacts.map((fact) => ({ ...fact, source: 'search' }));
  let floor = { applied: false };

  if (applyFloor && facts.length) {
    const threshold = config.memory.injectionFloor;
    const before = facts.length;
    facts = facts.filter((fact) => {
      const similarity = Number(fact.similarity);
      return !Number.isFinite(similarity) || similarity >= threshold;
    });
    floor = {
      applied: true,
      threshold,
      dropped: before - facts.length,
      kept: facts.length,
      note: 'facts below the absolute cosine floor were omitted',
    };
  }
  // Apply the limit after the relevance floor. Otherwise a full project tier
  // of weak matches could prevent a useful shared-memory fallback from ever
  // being considered for automatic recall.
  facts = facts.slice(0, safeLimit);
  if (floor.applied) floor.kept = facts.length;

  return {
    facts,
    chunks,
    _trace: {
      query,
      namespaces: searchedNamespaces,
      namespaceTiers: tiers,
      durationMs: Date.now() - startedAt,
      params: {
        limit: safeLimit,
        minConfidence,
        includeChunks,
        categories: categories || null,
        pointInTime: pointInTime || null,
      },
      strategy: 'hybrid',
      floor,
      ranking: {
        model: 'RRF(vector + keyword)',
        facts: facts.map((fact, index) => ({
          rank: index + 1,
          id: fact.id ?? null,
          content: String(fact.content || '').slice(0, 240),
          similarity: numberOrNull(fact.similarity),
          rrfRaw: numberOrNull(fact.rrf_raw),
          rrfScore: numberOrNull(fact.rrfScore),
        })),
        chunks: chunks.map((chunk, index) => ({
          rank: index + 1,
          id: chunk.id ?? null,
          content: String(chunk.content || '').slice(0, 200),
          similarity: numberOrNull(chunk.similarity),
          rrfScore: numberOrNull(chunk.rrfScore),
        })),
      },
    },
  };
}

async function searchFactTiers(query, queryEmbedding, tiers, options) {
  const results = [];
  const seen = new Set();
  const { applyFloor, ...searchOptions } = options;
  for (const tier of tiers) {
    const tierResults = await hybridSearchFacts(query, queryEmbedding, {
      namespaces: tier,
      ...searchOptions,
    });
    appendUnique(results, tierResults, seen);
    // Explicit searches show ranked evidence without a relevance floor. Once
    // the active project fills the requested result budget, a shared fallback
    // would only add latency and cannot be returned. Automatic recall keeps
    // searching: its floor runs after collection, so shared memory may still
    // be the useful fallback when project matches are weak.
    if (!applyFloor && results.length >= options.limit) break;
  }
  return results;
}

async function searchChunkTiers(query, queryEmbedding, tiers, limit) {
  const results = [];
  const seen = new Set();
  for (const namespaces of tiers) {
    const [vectorResults, keywordResults] = await Promise.all([
      vectorSearch.searchChunks(queryEmbedding, { namespaces, limit }),
      keywordSearch.searchChunks(query, { namespaces, limit }),
    ]);
    appendUnique(results, rrfMerge(vectorResults, keywordResults, limit), seen);
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

function normalizeNamespaceTiers(namespaceTiers, namespaces) {
  const candidateTiers = Array.isArray(namespaceTiers) && namespaceTiers.length
    ? namespaceTiers
    : [namespaces];
  const seen = new Set();
  return candidateTiers
    .map((tier) => (Array.isArray(tier) ? tier : []))
    .map((tier) => tier.map((value) => String(value || '').trim()).filter(Boolean))
    .map((tier) => tier.filter((namespace) => {
      if (seen.has(namespace)) return false;
      seen.add(namespace);
      return true;
    }))
    .filter((tier) => tier.length);
}

function appendUnique(target, incoming, seen) {
  for (const item of incoming || []) {
    const key = `${item.namespace || ''}:${item.id ?? item.uid ?? item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
  }
}

export function isSearchableQuery(query) {
  const value = String(query || '').trim();
  return Boolean(value) && !/^[*%_?\s]+$/.test(value);
}

function emptySearchResult() {
  return { facts: [], chunks: [] };
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

  const entries = Object.entries(scores).sort(([, left], [, right]) => right - left);
  const maxScore = entries[0]?.[1] || 1;
  return entries.slice(0, limit).map(([id, score]) => ({
    ...itemsById[id],
    rrfScore: Math.round((score / maxScore) * 100) / 100,
  }));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1e4) / 1e4 : null;
}
