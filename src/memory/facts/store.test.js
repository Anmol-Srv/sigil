import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock factories — safe to reference in both factory and tests
const { mockRaw, mockChain, mockFact } = vi.hoisted(() => {
  const mockFact = { id: 1, uid: 'fact-test-001', content: 'test fact', category: 'preference', status: 'active' };

  const mockChain = {
    insert: vi.fn(),
    where: vi.fn(),
    whereIn: vi.fn(),
    whereRaw: vi.fn(),
    first: vi.fn(),
    update: vi.fn(),
    returning: vi.fn(),
  };
  Object.values(mockChain).forEach((fn) => fn.mockReturnValue(mockChain));
  mockChain.returning.mockResolvedValue([mockFact]);
  mockChain.update.mockResolvedValue(1);
  mockChain.first.mockResolvedValue(null);

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

vi.mock('../../db/cortex.js', () => {
  const trx = Object.assign(vi.fn(() => mockChain), {
    raw: mockRaw,
    fn: { now: () => 'NOW()' },
    isTransaction: true,
  });
  return {
  default: Object.assign(vi.fn(() => mockChain), {
    raw: mockRaw,
    fn: { now: () => 'NOW()' },
    // findSimilar wraps its query in a transaction (SET LOCAL hnsw.ef_search = 40).
    // The transaction passes a `trx` object that exposes raw — route it back to the
    // shared mockRaw so existing test fixtures keep working.
    transaction: vi.fn(async (callback) => callback(trx)),
  }),
  };
});

import { embedOrThrow } from '../../ingestion/embedder.js';
import { promptJson } from '../../lib/llm.js';
import { saveFact } from './store.js';

// EMBEDDING_DIM is 1024; the precomputed-embedding path serializes through
// lib/vectors.js, which rejects anything that isn't 1024-d.
const FAKE_VEC = Array(1024).fill(0.1);

beforeEach(() => {
  vi.clearAllMocks();
  // Restore chain defaults after clearAllMocks
  Object.values(mockChain).forEach((fn) => fn.mockReturnValue(mockChain));
  mockChain.returning.mockResolvedValue([mockFact]);
  mockChain.update.mockResolvedValue(1);
  mockChain.first.mockResolvedValue(null);
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

// findSimilar runs inside a transaction that first issues `SET LOCAL hnsw.ef_search = 40`
// and then the actual SELECT. insertFact then issues an UPDATE for search_vector.
function mockFindSimilar(rows) {
  mockRaw
    .mockResolvedValueOnce({ rows: [] })  // SET LOCAL hnsw.ef_search = 40  (no rows)
    .mockResolvedValueOnce({ rows })      // findSimilar SELECT
    .mockResolvedValueOnce({ rows: [] }); // UPDATE search_vector (after insertFact)
}

describe('saveFact — AUDM decision branches', () => {
  it('no similar facts → ADD', async () => {
    mockFindSimilar([]);
    const result = await saveFact(baseArgs);
    expect(result.action).toBe('ADD');
    expect(result.fact).toBeDefined();
  });

  it('uses pre-computed embedding when provided (no embed() call)', async () => {
    mockFindSimilar([]);
    await saveFact({ ...baseArgs, embedding: FAKE_VEC });
    expect(embedOrThrow).not.toHaveBeenCalled();
  });

  it('similarity >= 0.88 → SKIP without LLM call', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL ef_search
      .mockResolvedValueOnce({
        rows: [{ id: 2, uid: 'fact-existing', content: 'I like mango', similarity: 0.92, status: 'active' }],
      });

    const result = await saveFact(baseArgs);
    expect(result.action).toBe('SKIP');
    expect(promptJson).not.toHaveBeenCalled();
  });

  it('revalidates exact content at commit so concurrent prepares do not duplicate', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockChain.first.mockResolvedValueOnce({
      id: 22,
      uid: 'fact-raced',
      content: baseArgs.content,
      namespace: 'default',
      status: 'active',
      sourceDocumentIds: [9],
    });

    const result = await saveFact(baseArgs);
    expect(result).toMatchObject({ action: 'SKIP', existing: { id: 22 } });
    expect(result.audm.decision).toBe('skip-concurrent-exact');
  });

  it('weak match below the supersede floor → ADD without LLM call', async () => {
    // findSimilar applies the supersede floor (0.72) in SQL, so a neighbor at
    // 0.50 is dropped before saveFact ever sees it — the SELECT comes back empty.
    // No candidate ⇒ ADD, and the AUDM judge (LLM) is never consulted.
    mockRaw
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL ef_search
      .mockResolvedValueOnce({ rows: [] }) // findSimilar SELECT — floor filters out the weak match
      .mockResolvedValueOnce({ rows: [] }); // search_vector update

    const result = await saveFact(baseArgs);
    expect(result.action).toBe('ADD');
    expect(promptJson).not.toHaveBeenCalled();
  });

  it('similarity in [0.78, 0.88) + LLM says UPDATE → UPDATE (new fact inserted, old superseded)', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL ef_search
      .mockResolvedValueOnce({
        rows: [{ id: 2, uid: 'fact-old', content: 'I like apples', similarity: 0.82, status: 'active' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // search_vector for inserted fact
    promptJson.mockResolvedValueOnce({ decisions: [{ input_index: 0, candidate_key: 'fact:2', action: 'UPDATE' }] });

    const result = await saveFact(baseArgs);
    expect(result.action).toBe('UPDATE');
    expect(result.supersededId).toBe(2);
    expect(result.fact).toBeDefined();
    expect(promptJson).toHaveBeenCalledTimes(1);
  });

  it('similarity in [0.78, 0.88) + LLM says CONTRADICT → CONTRADICT', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL ef_search
      .mockResolvedValueOnce({
        rows: [{ id: 3, uid: 'fact-stale', content: 'We use MySQL', similarity: 0.80, status: 'active' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    promptJson.mockResolvedValueOnce({ decisions: [{ input_index: 0, candidate_key: 'fact:3', action: 'CONTRADICT' }] });

    const result = await saveFact(baseArgs);
    expect(result.action).toBe('CONTRADICT');
    expect(result.contradictedId).toBe(3);
    expect(result.fact).toBeDefined();
  });

  it('"CONTRADICTION" (longer form) also parses as CONTRADICT', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL ef_search
      .mockResolvedValueOnce({
        rows: [{ id: 4, uid: 'fact-4', content: 'old content', similarity: 0.81, status: 'active' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    promptJson.mockResolvedValueOnce({ decisions: [{ input_index: 0, candidate_key: 'fact:4', action: 'CONTRADICT' }] });

    const result = await saveFact(baseArgs);
    expect(result.action).toBe('CONTRADICT');
  });

  it('similarity in [0.78, 0.88) + LLM returns neither UPDATE nor CONTRADICT → ADD', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL ef_search
      .mockResolvedValueOnce({
        rows: [{ id: 5, uid: 'fact-5', content: 'related but different', similarity: 0.79, status: 'active' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    promptJson.mockResolvedValueOnce({ decisions: [{ input_index: 0, candidate_key: 'fact:5', action: 'ADD' }] });

    const result = await saveFact(baseArgs);
    expect(result.action).toBe('ADD');
  });

  it('rejects an incomplete AUDM batch instead of silently defaulting it to ADD', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 6, uid: 'fact-6', content: 'possibly stale', similarity: 0.80, status: 'active' }],
      });
    promptJson.mockResolvedValueOnce({ decisions: [] });

    await expect(saveFact(baseArgs)).rejects.toThrow('0/1 required decisions');
  });
});
