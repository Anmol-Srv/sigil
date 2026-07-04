// P7 write-side test: insertFact stamps created_by_origin with the value from
// currentOrigin(), so a shared DB can isolate private facts per owner.

import { describe, it, expect, vi } from 'vitest';

const { mockRaw, mockChain, mockFact } = vi.hoisted(() => {
  const mockFact = { id: 1, uid: 'fact-test-001', content: 'x', status: 'active' };
  const mockChain = { insert: vi.fn(), where: vi.fn(), whereIn: vi.fn(), update: vi.fn(), returning: vi.fn() };
  Object.values(mockChain).forEach((fn) => fn.mockReturnValue(mockChain));
  mockChain.returning.mockResolvedValue([mockFact]);
  const mockRaw = vi.fn();
  return { mockRaw, mockChain, mockFact };
});

vi.mock('../../ingestion/embedder.js', () => ({
  embed: vi.fn(), embedBatch: vi.fn(), embedOrThrow: vi.fn(), embedBatchOrThrow: vi.fn(),
}));
vi.mock('../../lib/llm.js', () => ({ prompt: vi.fn(), promptJson: vi.fn(), parseJson: vi.fn() }));
vi.mock('../../lib/vectors.js', () => ({
  pgVector: (v) => v, pgHalfvecColumn: () => '', pgHalfvecParam: () => '',
}));
vi.mock('../provenance.js', () => ({ currentOrigin: () => 'origin-X' }));
vi.mock('../../db/cortex.js', () => ({
  default: Object.assign(vi.fn(() => mockChain), {
    raw: mockRaw,
    fn: { now: () => 'NOW()' },
    transaction: vi.fn(async (cb) => cb({ raw: mockRaw })),
  }),
}));

import { insertFact } from './store.js';

describe('insertFact created_by_origin stamping (P7)', () => {
  it('stamps created_by_origin with the value from currentOrigin()', async () => {
    await insertFact({
      content: 'a fact',
      category: 'preference',
      confidence: 'high',
      importance: 'supplementary',
      namespace: 'default',
      sourceDocumentIds: [],
      sourceSection: null,
      embedding: [0.1, 0.2, 0.3],
    });

    expect(mockChain.insert).toHaveBeenCalledTimes(1);
    const payload = mockChain.insert.mock.calls[0][0];
    expect(payload.createdByOrigin).toBe('origin-X');
  });
});
