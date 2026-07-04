import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { search } from './hybrid.js';

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
  routeQuery.mockResolvedValue({
    intent: 'factual',
    categories: [],
    useGraph: false,
    expand: false,
    limit: null,
    pointInTime: null,
    reasoning: '',
  });
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

describe('search — author provenance filters (--agent / --device)', () => {
  // Facts carry created_by_agent / created_by_device_id. The SQL layer applies
  // the predicates (mocked here), and search() re-applies them as a post-filter
  // so entity-linked facts that bypass the SQL still respect the filter.
  const makeAuthoredFacts = () => ([
    { ...makeFactList([1])[0], createdByAgent: 'claude-code', createdByDeviceId: 1 },
    { ...makeFactList([2])[0], createdByAgent: 'cursor', createdByDeviceId: 1 },
    { ...makeFactList([3])[0], createdByAgent: 'cursor', createdByDeviceId: 2 },
    { ...makeFactList([4])[0], createdByAgent: 'cli', createdByDeviceId: null },
  ]);

  it('threads agent + deviceId into the hybrid-sql layer', async () => {
    hybridSearchFacts.mockResolvedValue([]);

    await search('test', { namespaces: ['default'], agent: 'cursor', deviceId: 2 });

    const opts = hybridSearchFacts.mock.calls[0][2];
    expect(opts.agent).toBe('cursor');
    expect(opts.deviceId).toBe(2);
  });

  it('no author flags ⟹ no agent/device predicate (back-compat)', async () => {
    hybridSearchFacts.mockResolvedValue([]);

    await search('test', { namespaces: ['default'] });

    const opts = hybridSearchFacts.mock.calls[0][2];
    expect(opts.agent).toBeNull();
    expect(opts.deviceId).toBeNull();
  });

  it('--agent returns only that agent\'s facts', async () => {
    hybridSearchFacts.mockResolvedValue(makeAuthoredFacts());

    const result = await search('test', { namespaces: ['default'], agent: 'cursor' });

    expect(result.facts.map((f) => f.id).sort()).toEqual([2, 3]);
    expect(result.facts.every((f) => f.createdByAgent === 'cursor')).toBe(true);
  });

  it('--device returns only that device\'s facts', async () => {
    hybridSearchFacts.mockResolvedValue(makeAuthoredFacts());

    const result = await search('test', { namespaces: ['default'], deviceId: 1 });

    expect(result.facts.map((f) => f.id).sort()).toEqual([1, 2]);
  });

  it('--agent + --device intersect (both predicates apply)', async () => {
    hybridSearchFacts.mockResolvedValue(makeAuthoredFacts());

    const result = await search('test', { namespaces: ['default'], agent: 'cursor', deviceId: 1 });

    expect(result.facts.map((f) => f.id)).toEqual([2]);
  });

  it('post-filter drops entity-linked facts that bypass the SQL predicate', async () => {
    // Simulate the entity-first path leaking a non-matching entity-linked fact
    // into the result set (getFactsForEntity does not apply the SQL filter).
    hybridSearchFacts.mockResolvedValue([
      { ...makeFactList([7])[0], createdByAgent: 'cursor', createdByDeviceId: 1, source: 'entity' },
      { ...makeFactList([8])[0], createdByAgent: 'cli', createdByDeviceId: 1, source: 'entity' },
    ]);

    const result = await search('test', { namespaces: ['default'], agent: 'cursor' });

    expect(result.facts.map((f) => f.id)).toEqual([7]);
  });

  it('returns nothing when no fact matches the author filter', async () => {
    hybridSearchFacts.mockResolvedValue(makeAuthoredFacts());

    const result = await search('test', { namespaces: ['default'], agent: 'nobody' });

    expect(result.facts).toEqual([]);
  });
});
