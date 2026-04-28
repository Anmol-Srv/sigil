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
