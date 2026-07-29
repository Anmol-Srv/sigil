import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock factories — safe to reference in both factory and tests
const { mockRaw, mockChain, mockFact } = vi.hoisted(() => {
  const mockFact = { id: 1, uid: 'fact-test-001', content: 'test fact', category: 'preference', status: 'active' };

  const mockChain = {
    insert: vi.fn(),
    where: vi.fn(),
    whereIn: vi.fn(),
    update: vi.fn(),
    returning: vi.fn(),
  };
  Object.values(mockChain).forEach((fn) => fn.mockReturnValue(mockChain));
  mockChain.returning.mockResolvedValue([mockFact]);
  mockChain.update.mockResolvedValue(1);

  const mockRaw = vi.fn();

  return { mockRaw, mockChain, mockFact };
});

vi.mock('../../ingestion/embedder.js', () => ({
  embed: vi.fn(),
  embedBatch: vi.fn(),
  embedOrThrow: vi.fn(),
  embedBatchOrThrow: vi.fn(),
}));

vi.mock('../../lib/llm.js', () => ({
  prompt: vi.fn(),
  promptJson: vi.fn(),
  parseJson: vi.fn(),
}));

vi.mock('../../db/cortex.js', () => ({
  default: Object.assign(vi.fn(() => mockChain), {
    raw: mockRaw,
    fn: { now: () => 'NOW()' },
    // findSimilar wraps its query in a transaction (SET LOCAL hnsw.ef_search = 40).
    // The transaction passes a `trx` object that exposes raw — route it back to the
    // shared mockRaw so existing test fixtures keep working.
    transaction: vi.fn(async (callback) => callback({ raw: mockRaw })),
  }),
}));

import { embedOrThrow } from '../../ingestion/embedder.js';
import { saveFactDeterministic } from './store.js';

// EMBEDDING_DIM is 1024; the precomputed-embedding path serializes through
// lib/vectors.js, which rejects anything that isn't 1024-d.
const FAKE_VEC = Array(1024).fill(0.1);

beforeEach(() => {
  vi.clearAllMocks();
  // Restore chain defaults after clearAllMocks
  Object.values(mockChain).forEach((fn) => fn.mockReturnValue(mockChain));
  mockChain.returning.mockResolvedValue([mockFact]);
  mockChain.update.mockResolvedValue(1);
  embedOrThrow.mockResolvedValue(FAKE_VEC);
});

const baseArgs = {
  content: 'I like mango better than apple',
  category: 'preference',
  confidence: 'high',
  importance: 'vital',
  namespace: 'default',
  sourceDocumentIds: [1],
  sourceSection: 'preference',
};

// Exact duplicate lookup runs first; insertFact then updates search_vector.
function mockFindExact(rows) {
  mockRaw
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [] }); // UPDATE search_vector (after insertFact)
}

describe('saveFactDeterministic — direct atomic writes', () => {
  it('adds a distinct fact without invoking the LLM judge', async () => {
    mockFindExact([]);

    const result = await saveFactDeterministic(baseArgs);

    expect(result.action).toBe('ADD');
    expect(result.dedup.decision).toBe('deterministic-add');
  });

  it('skips a normalized exact duplicate before calling the embedder', async () => {
    mockRaw.mockResolvedValueOnce({
      rows: [{ id: 2, uid: 'fact-existing', content: baseArgs.content, status: 'active' }],
    });

    const result = await saveFactDeterministic(baseArgs);

    expect(result.action).toBe('SKIP');
    expect(result.dedup.decision).toBe('normalized-exact-duplicate');
    expect(embedOrThrow).not.toHaveBeenCalled();
  });
});
