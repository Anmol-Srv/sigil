import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock all external deps before importing hybrid
vi.mock('../../ingestion/embedder.js', () => ({
  embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
  embedBatch: vi.fn().mockResolvedValue([Array(768).fill(0.1)]),
}));

vi.mock('../facts/store.js', () => ({
  recordAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../entities/store.js', () => ({
  findByName: vi.fn().mockResolvedValue(null),
  searchByName: vi.fn().mockResolvedValue([]),
}));

vi.mock('../facts/entity-linker.js', () => ({
  getFactsForEntity: vi.fn().mockResolvedValue([]),
  getEntityIdsForFacts: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../lifecycle/entity-hebbian.js', () => ({
  strengthenEntityEdges: vi.fn().mockResolvedValue(undefined),
  getEdgeStrengthsForRanking: vi.fn().mockResolvedValue(new Map()),
  getCoRetrievedEntities: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lifecycle/hebbian.js', () => ({
  strengthenEdges: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../entities/relations.js', () => ({
  listRelationsForEntity: vi.fn().mockResolvedValue([]),
}));

vi.mock('./graph-enhancement.js', () => ({
  extractEntitiesFromFacts: vi.fn().mockResolvedValue([]),
  findRelatedFacts: vi.fn().mockResolvedValue([]),
  rerank: vi.fn((facts) => facts),
}));

// The remote decision layer has its own adapter suite. Hybrid tests pin the
// production candidate handoff without requiring a configured credential or a
// network call in CI.
vi.mock('../../lib/jev.js', () => ({
  rerankFacts: vi.fn(async (_query, facts) => ({
    facts,
    meta: { applied: false, reason: 'disabled' },
  })),
}));

vi.mock('./query-expander.js', () => ({
  expandQuery: vi.fn().mockResolvedValue(['original query']),
}));

vi.mock('../cognitive/query-router.js', () => ({
  routeQuery: vi.fn().mockResolvedValue({
    intent: 'factual',
    categories: [],
    useGraph: false,
    expand: false,
    limit: null,
    pointInTime: null,
    reasoning: 'factual query',
  }),
}));

// vector + keyword are only used for chunk search now (facts go through hybrid-sql)
vi.mock('./vector.js', () => ({
  searchChunks: vi.fn().mockResolvedValue([]),
  searchFacts: vi.fn().mockResolvedValue([]),
}));

vi.mock('./keyword.js', () => ({
  searchChunks: vi.fn().mockResolvedValue([]),
  searchFacts: vi.fn().mockResolvedValue([]),
}));

vi.mock('./hybrid-sql.js', () => ({
  hybridSearchFacts: vi.fn(),
}));

// Synthesizer fires for every search call. Without this mock the real wrapper
// spawns the configured LLM (Claude CLI / Anthropic API) — turns 1ms tests
// into 7-10s tests and occasionally trips the default 10s timeout.
vi.mock('../../lib/llm.js', () => ({
  prompt: vi.fn().mockResolvedValue('synthesized'),
  promptJson: vi.fn().mockResolvedValue({}),
}));

import { hybridSearchFacts } from './hybrid-sql.js';
import { routeQuery } from '../cognitive/query-router.js';
import { extractEntitiesFromFacts, findRelatedFacts, rerank } from './graph-enhancement.js';
import { rerankFacts } from '../../lib/jev.js';
import { search } from './hybrid.js';
import { __setTestConfig, __resetTestConfig } from '../../setup/config-store.js';

// Jev now implies useGraph, so these tests must not read the developer's real
// ~/.sigil/config.json — CI behaviour would depend on whether Jev is enabled
// on the machine running it.
afterAll(() => __resetTestConfig());

const makeFactList = (ids) =>
  ids.map((id, i) => ({
    id,
    uid: `fact-${id}`,
    content: `Fact number ${id}`,
    category: 'domain_knowledge',
    confidence: 'high',
    importance: 'supplementary',
    namespace: 'default',
    status: 'active',
    rrfScore: 1 - i * 0.1, // SQL-side RRF already produced these
  }));

beforeEach(() => {
  vi.clearAllMocks();
  __setTestConfig({ jev: { enabled: false, autoInject: false } });
  routeQuery.mockResolvedValue({
    intent: 'factual',
    categories: [],
    useGraph: false,
    expand: false,
    limit: null,
    pointInTime: null,
    reasoning: '',
  });
  rerankFacts.mockImplementation(async (_query, facts) => ({
    facts,
    meta: { applied: false, reason: 'disabled' },
  }));
  rerank.mockImplementation((facts) => facts);
});

describe('search — facade behavior', () => {
  it('returns facts from hybrid-sql layer', async () => {
    const facts = makeFactList([1, 2, 3]);
    hybridSearchFacts.mockResolvedValue(facts);

    const result = await search('test query', { namespaces: ['default'], limit: 10 });

    expect(result.facts).toHaveLength(3);
    expect(result.facts.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('returns empty when hybrid-sql returns nothing', async () => {
    hybridSearchFacts.mockResolvedValue([]);

    const result = await search('no results query', { namespaces: ['default'] });

    expect(result.facts).toHaveLength(0);
  });

  it('short-circuits wildcard-only queries before routing or retrieval', async () => {
    const result = await search('*', { namespaces: ['default'] });

    expect(result).toMatchObject({
      facts: [],
      chunks: [],
      matchedEntity: null,
      relatedEntities: [],
    });
    expect(routeQuery).not.toHaveBeenCalled();
    expect(hybridSearchFacts).not.toHaveBeenCalled();
  });

  it('passes namespace, limit, minConfidence to hybrid-sql', async () => {
    hybridSearchFacts.mockResolvedValue([]);

    await search('test', {
      namespaces: ['work'],
      limit: 5,
      minConfidence: 'high',
    });

    const call = hybridSearchFacts.mock.calls[0];
    expect(call[0]).toBe('test');              // query
    expect(call[2]).toMatchObject({            // options
      namespaces: ['work'],
      limit: 5,
      minConfidence: 'high',
    });
  });

  it('passes category filter from query router', async () => {
    routeQuery.mockResolvedValue({
      intent: 'preference',
      categories: ['preference', 'opinion', 'personal'],
      useGraph: false,
      expand: false,
      limit: null,
      pointInTime: null,
      reasoning: '',
    });
    hybridSearchFacts.mockResolvedValue([]);

    await search('what fruit do I like?', { namespaces: ['default'] });

    const call = hybridSearchFacts.mock.calls[0];
    expect(call[2].categories).toEqual(['preference', 'opinion', 'personal']);
  });

  it('preserves rrfScore field from hybrid-sql', async () => {
    hybridSearchFacts.mockResolvedValue(makeFactList([42]));

    const result = await search('test', { namespaces: ['default'], limit: 5 });

    expect(result.facts[0]).toHaveProperty('rrfScore');
    expect(typeof result.facts[0].rrfScore).toBe('number');
  });

  it('preserves importance field', async () => {
    const vitalFact = { ...makeFactList([10])[0], importance: 'vital' };
    const suppFact = { ...makeFactList([11])[0], importance: 'supplementary' };
    hybridSearchFacts.mockResolvedValue([vitalFact, suppFact]);

    const result = await search('test', { namespaces: ['default'], limit: 5 });
    const byId = Object.fromEntries(result.facts.map((f) => [f.id, f]));

    expect(byId[10].importance).toBe('vital');
    expect(byId[11].importance).toBe('supplementary');
  });

  it('carries the authorized search scope into graph expansion', async () => {
    hybridSearchFacts.mockResolvedValue(makeFactList([1]));
    extractEntitiesFromFacts.mockResolvedValue([{ id: 44 }]);
    findRelatedFacts.mockResolvedValue([]);
    const viewer = { agent: 'reviewer', deviceId: 7 };

    await search('test', {
      namespaces: ['project-a'],
      limit: 5,
      minConfidence: 'high',
      categories: ['decision'],
      useGraph: true,
      viewer,
      podScope: 'global',
    });

    expect(findRelatedFacts).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      namespaces: ['project-a'], minConfidence: 'high', categories: ['decision'], viewer,
    }));
  });

  it('hands the graph-expanded local pool to Jev before applying the public limit', async () => {
    __setTestConfig({ jev: { enabled: true } });
    hybridSearchFacts.mockResolvedValue(makeFactList([1, 2]));
    extractEntitiesFromFacts.mockResolvedValue([{ id: 44 }]);
    findRelatedFacts.mockResolvedValue([{ id: 3, content: 'Related graph evidence', rrfScore: 0.5, relationPath: 'Cache (depends_on)' }]);
    rerank.mockImplementation((direct, related) => [
      ...direct.map((fact) => ({ ...fact, resultType: 'direct' })),
      ...related.map((fact) => ({ ...fact, resultType: 'related' })),
    ]);
    rerankFacts.mockImplementation(async (_query, candidates) => ({
      facts: [
        { ...candidates[2], resultType: 'graph-reranked', reranker: 'jev', jevScore: 0.94 },
        ...candidates.slice(0, 2),
      ],
      meta: { applied: true, model: 'fixture-system-one', candidates: 3, reranked: 1, floor: 0.7 },
    }));

    const result = await search('how did the cache decision affect dependencies?', {
      namespaces: ['default'], useGraph: true, limit: 2, route: false, applyFloor: false,
    });

    expect(rerankFacts).toHaveBeenCalledWith(
      'how did the cache decision affect dependencies?',
      expect.arrayContaining([expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 }), expect.objectContaining({ id: 3 })]),
    );
    expect(result.facts).toMatchObject([
      { id: 3, resultType: 'graph-reranked', reranker: 'jev', jevScore: 0.94 },
      { id: 1 },
    ]);
    expect(result.jev).toMatchObject({ applied: true, model: 'fixture-system-one', reranked: 1 });
  });

  it('leaves auto-injection on the local path unless jev.autoInject is set', async () => {
    __setTestConfig({ jev: { enabled: true, autoInject: false } });
    hybridSearchFacts.mockResolvedValue(makeFactList([1, 2]));

    const result = await search('test', { namespaces: ['default'], limit: 5, route: false, applyFloor: true });

    expect(rerankFacts).not.toHaveBeenCalled();
    expect(result.jev).toMatchObject({ applied: false, reason: 'auto_injection_excluded' });
  });

  it('re-ranks auto-injection once jev.autoInject is turned on', async () => {
    __setTestConfig({ jev: { enabled: true, autoInject: true } });
    hybridSearchFacts.mockResolvedValue(makeFactList([1, 2]));

    await search('test', { namespaces: ['default'], limit: 5, route: false, applyFloor: true });

    expect(rerankFacts).toHaveBeenCalled();
  });

  it('turns graph expansion on whenever Jev is enabled', async () => {
    // Without expansion the pool is exactly `limit`, so Jev could only reorder
    // what local search already picked.
    __setTestConfig({ jev: { enabled: true } });
    hybridSearchFacts.mockResolvedValue(makeFactList([1]));
    extractEntitiesFromFacts.mockResolvedValue([{ id: 44 }]);
    findRelatedFacts.mockResolvedValue([]);

    await search('test', { namespaces: ['default'], limit: 5, useGraph: false, route: false, applyFloor: false });

    expect(findRelatedFacts).toHaveBeenCalled();
  });

  it('re-ranks an explicit search even when the caller asked for no graph', async () => {
    // Gating Jev on useGraph meant a caller who passed useGraph:false skipped
    // the decision layer entirely, however explicitly they had asked.
    __setTestConfig({ jev: { enabled: true } });
    hybridSearchFacts.mockResolvedValue(makeFactList([1, 2]));
    rerankFacts.mockImplementation(async (_query, candidates) => ({
      facts: [...candidates].reverse(),
      meta: { applied: true, model: 'fixture-system-one', candidates: 2, reranked: 2 },
    }));

    const result = await search('test', { namespaces: ['default'], limit: 5, useGraph: false, route: false, applyFloor: false });

    expect(rerankFacts).toHaveBeenCalled();
    expect(result.facts.map((f) => f.id)).toEqual([2, 1]);
    expect(result.jev).toMatchObject({ applied: true });
  });

  it('runs the relevance floor before Jev, so dropped facts are never sent', async () => {
    // Graph facts carry no `similarity` and are floor-exempt; ordering Jev
    // first would let one reach injection without passing any gate.
    __setTestConfig({ jev: { enabled: true, autoInject: true } });
    const facts = makeFactList([1, 2]);
    facts[0].similarity = 0.9;
    facts[1].similarity = 0.1;
    hybridSearchFacts.mockResolvedValue(facts);

    await search('test', { namespaces: ['default'], limit: 5, route: false, applyFloor: true });

    const [, sent] = rerankFacts.mock.calls[0];
    expect(sent.map((f) => f.id)).toEqual([1]);
  });

  it('respects limit parameter from router override', async () => {
    routeQuery.mockResolvedValue({
      intent: 'exploratory',
      categories: [],
      useGraph: false,
      expand: false,
      limit: 15,
      pointInTime: null,
      reasoning: '',
    });
    hybridSearchFacts.mockResolvedValue([]);

    await search('test', { namespaces: ['default'], limit: 5 });

    const call = hybridSearchFacts.mock.calls[0];
    // Router's limit should win
    expect(call[2].limit).toBe(15);
  });

  it('empty chunks when includeChunks is false (default)', async () => {
    hybridSearchFacts.mockResolvedValue(makeFactList([1]));

    const result = await search('test', { namespaces: ['default'], limit: 5 });

    expect(result.chunks).toEqual([]);
  });
});
