import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../ingestion/embedder.js', () => ({
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0.1)),
}));
vi.mock('./vector.js', () => ({ searchChunks: vi.fn().mockResolvedValue([]) }));
vi.mock('./keyword.js', () => ({ searchChunks: vi.fn().mockResolvedValue([]) }));
vi.mock('./hybrid-sql.js', () => ({ hybridSearchFacts: vi.fn() }));

import config from '../../config.js';
import { hybridSearchFacts } from './hybrid-sql.js';
import { search } from './hybrid.js';

const relevant = {
  id: 1, content: 'on-topic fact', confidence: 'high',
  importance: 'supplementary', similarity: 0.9, rrfScore: 1,
};
const tangential = {
  id: 2, content: 'off-topic fact', confidence: 'high',
  importance: 'supplementary', similarity: 0.4, rrfScore: 0.8,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('precision-first relevance floor', () => {
  it('drops below-floor facts on automatic recall', async () => {
    hybridSearchFacts.mockResolvedValue([relevant, tangential]);

    const result = await search('q');

    expect(result.facts.map((fact) => fact.id)).toEqual([1]);
    expect(result._trace.floor).toMatchObject({
      applied: true,
      threshold: config.memory.injectionFloor,
      dropped: 1,
      kept: 1,
    });
  });

  it('keeps all ranked evidence for explicit search', async () => {
    hybridSearchFacts.mockResolvedValue([relevant, tangential]);

    const result = await search('q', { applyFloor: false });

    expect(result.facts.map((fact) => fact.id)).toEqual([1, 2]);
    expect(result._trace.floor.applied).toBe(false);
  });

  it('returns empty rather than injecting only weak matches', async () => {
    hybridSearchFacts.mockResolvedValue([
      { ...tangential, id: 3, similarity: 0.5 },
      { ...tangential, id: 4, similarity: 0.3 },
    ]);

    const result = await search('off-topic');

    expect(result.facts).toEqual([]);
  });
});
