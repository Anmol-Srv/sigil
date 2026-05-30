// Precision-first relevance floor (Lane A of the trustable-memory build).
//
// Locks the behaviour that protects the user's trust: for auto-injection
// paths (applyFloor=true, the default), facts whose absolute cosine
// similarity is below config.memory.injectionFloor are dropped — "empty but
// honest beats full but off-topic". Explicit search (applyFloor=false) keeps
// everything. Mirrors hybrid.test.js's mock harness so the floor is exercised
// through the real search() orchestration without a DB or embedding provider.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ingestion/embedder.js', () => ({
  embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
  embedBatch: vi.fn().mockResolvedValue([Array(768).fill(0.1)]),
}));
vi.mock('../facts/store.js', () => ({ recordAccess: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock('../lifecycle/hebbian.js', () => ({ strengthenEdges: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../entities/relations.js', () => ({ listRelationsForEntity: vi.fn().mockResolvedValue([]) }));
vi.mock('./graph-enhancement.js', () => ({
  extractEntitiesFromFacts: vi.fn().mockResolvedValue([]),
  findRelatedFacts: vi.fn().mockResolvedValue([]),
  rerank: vi.fn((facts) => facts),
}));
vi.mock('./query-expander.js', () => ({ expandQuery: vi.fn().mockResolvedValue(['original query']) }));
vi.mock('../cognitive/query-router.js', () => ({
  routeQuery: vi.fn().mockResolvedValue({
    intent: 'factual', categories: [], useGraph: false, expand: false, limit: null, pointInTime: null, reasoning: '',
  }),
}));
vi.mock('./vector.js', () => ({ searchChunks: vi.fn().mockResolvedValue([]), searchFacts: vi.fn().mockResolvedValue([]) }));
vi.mock('./keyword.js', () => ({ searchChunks: vi.fn().mockResolvedValue([]), searchFacts: vi.fn().mockResolvedValue([]) }));
vi.mock('./hybrid-sql.js', () => ({ hybridSearchFacts: vi.fn() }));
vi.mock('../../lib/llm.js', () => ({
  prompt: vi.fn().mockResolvedValue('synthesized'),
  promptJson: vi.fn().mockResolvedValue({}),
}));

import { hybridSearchFacts } from './hybrid-sql.js';
import { search } from './hybrid.js';
import config from '../../config.js';

// One clearly-relevant fact (cosine 0.9) and one tangential fact (cosine 0.4)
// — the tangential one is the "Maya Iyer" class of off-topic match.
const FLOOR = config.memory.injectionFloor; // default 0.6
const relevant = {
  id: 1, uid: 'fact-1', content: 'on-topic fact', category: 'domain_knowledge',
  confidence: 'high', importance: 'supplementary', namespace: 'default', status: 'active',
  similarity: 0.9,
};
const tangential = {
  id: 2, uid: 'fact-2', content: 'off-topic fact', category: 'domain_knowledge',
  confidence: 'high', importance: 'supplementary', namespace: 'default', status: 'active',
  similarity: 0.4,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('relevance floor (precision-first injection)', () => {
  it('drops below-floor facts by default (applyFloor implicitly true)', async () => {
    hybridSearchFacts.mockResolvedValue([relevant, tangential]);

    const result = await search('q', { namespaces: ['default'], limit: 10, synthesize: false });

    expect(result.facts.map((f) => f.id)).toEqual([1]); // tangential 0.4 < floor dropped
    expect(FLOOR).toBeGreaterThan(0.4);
  });

  it('keeps below-floor facts for explicit search (applyFloor: false)', async () => {
    hybridSearchFacts.mockResolvedValue([relevant, tangential]);

    const result = await search('q', { namespaces: ['default'], limit: 10, synthesize: false, applyFloor: false });

    expect(result.facts.map((f) => f.id).sort()).toEqual([1, 2]);
  });

  it('injects NOTHING when every match is below the floor (empty beats wrong)', async () => {
    hybridSearchFacts.mockResolvedValue([{ ...tangential, id: 3, similarity: 0.5 }, { ...tangential, id: 4, similarity: 0.3 }]);

    const result = await search('off-topic query', { namespaces: ['default'], limit: 10, synthesize: false });

    expect(result.facts).toHaveLength(0);
  });

  it('records the floor outcome in the trace so the Activity log explains the silence', async () => {
    hybridSearchFacts.mockResolvedValue([relevant, tangential]);

    const result = await search('q', { namespaces: ['default'], limit: 10, synthesize: false });

    expect(result._trace.floor).toMatchObject({ applied: true, dropped: 1, kept: 1 });
    expect(result._trace.floor.threshold).toBe(FLOOR);
  });
});
