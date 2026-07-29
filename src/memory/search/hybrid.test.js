import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../ingestion/embedder.js', () => ({
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0.1)),
}));
vi.mock('./vector.js', () => ({
  searchChunks: vi.fn().mockResolvedValue([]),
}));
vi.mock('./keyword.js', () => ({
  searchChunks: vi.fn().mockResolvedValue([]),
}));
vi.mock('./hybrid-sql.js', () => ({
  hybridSearchFacts: vi.fn(),
}));

import { embed } from '../../ingestion/embedder.js';
import { hybridSearchFacts } from './hybrid-sql.js';
import * as keywordSearch from './keyword.js';
import * as vectorSearch from './vector.js';
import { search } from './hybrid.js';

const makeFacts = (ids) => ids.map((id, index) => ({
  id,
  uid: `fact-${id}`,
  content: `Fact ${id}`,
  category: 'domain_knowledge',
  confidence: 'high',
  importance: 'supplementary',
  namespace: 'default',
  status: 'active',
  similarity: 0.9 - index * 0.05,
  rrf_raw: 0.03 - index * 0.001,
  rrfScore: 1 - index * 0.1,
}));

beforeEach(() => {
  vi.clearAllMocks();
  hybridSearchFacts.mockResolvedValue([]);
});

describe('deterministic hybrid search', () => {
  it('embeds once and returns the SQL-fused facts without hidden generation', async () => {
    hybridSearchFacts.mockResolvedValue(makeFacts([1, 2]));

    const result = await search('test query', {
      namespaces: ['work'],
      limit: 5,
      minConfidence: 'high',
      categories: ['preference'],
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith('test query', { inputType: 'query' });
    expect(hybridSearchFacts).toHaveBeenCalledWith(
      'test query',
      expect.any(Array),
      expect.objectContaining({
        namespaces: ['work'],
        limit: 5,
        minConfidence: 'high',
        categories: ['preference'],
      }),
    );
    expect(result.facts.map((fact) => fact.id)).toEqual([1, 2]);
    expect(result._trace.ranking.model).toBe('RRF(vector + keyword)');
  });

  it('guards empty and wildcard-only queries before embedding or database work', async () => {
    for (const query of ['', '  ', '*', '%%%']) {
      const result = await search(query);
      expect(result.facts).toEqual([]);
    }

    expect(embed).not.toHaveBeenCalled();
    expect(hybridSearchFacts).not.toHaveBeenCalled();
  });

  it('clamps the result limit to a safe range', async () => {
    await search('many results', { limit: 1000 });

    expect(hybridSearchFacts.mock.calls[0][2].limit).toBe(100);
  });

  it('searches chunks only when explicitly requested and fuses their ranks', async () => {
    vectorSearch.searchChunks.mockResolvedValue([
      { id: 1, content: 'vector first', similarity: 0.9 },
      { id: 2, content: 'vector second', similarity: 0.8 },
    ]);
    keywordSearch.searchChunks.mockResolvedValue([
      { id: 2, content: 'keyword first' },
      { id: 3, content: 'keyword second' },
    ]);

    const result = await search('document detail', { includeChunks: true, limit: 3 });

    expect(vectorSearch.searchChunks).toHaveBeenCalledOnce();
    expect(keywordSearch.searchChunks).toHaveBeenCalledOnce();
    expect(result.chunks.map((chunk) => chunk.id)).toEqual([2, 1, 3]);
    expect(result.chunks[0].rrfScore).toBe(1);
  });

  it('does not touch chunk retrieval for fact-only search', async () => {
    await search('fact only');

    expect(vectorSearch.searchChunks).not.toHaveBeenCalled();
    expect(keywordSearch.searchChunks).not.toHaveBeenCalled();
  });

  it('embeds once while searching a project before shared memory', async () => {
    const projectNamespace = 'project:1234567890abcdef12345678';
    hybridSearchFacts
      .mockResolvedValueOnce([{ ...makeFacts([1])[0], namespace: projectNamespace }])
      .mockResolvedValueOnce([{ ...makeFacts([2])[0], namespace: 'default' }]);

    const result = await search('scoped decision', {
      namespaces: [projectNamespace, 'default'],
      namespaceTiers: [[projectNamespace], ['default']],
      applyFloor: false,
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(hybridSearchFacts).toHaveBeenNthCalledWith(1, 'scoped decision', expect.any(Array), expect.objectContaining({
      namespaces: [projectNamespace],
    }));
    expect(hybridSearchFacts).toHaveBeenNthCalledWith(2, 'scoped decision', expect.any(Array), expect.objectContaining({
      namespaces: ['default'],
    }));
    expect(result.facts.map((fact) => fact.namespace)).toEqual([projectNamespace, 'default']);
    expect(result._trace.namespaceTiers).toEqual([[projectNamespace], ['default']]);
  });
});
