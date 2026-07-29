import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embedBatchOrThrow: vi.fn(),
  saveFactDeterministic: vi.fn(),
  findExactFact: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../db/cortex.js', () => ({
  default: {
    transaction: mocks.transaction,
  },
}));

vi.mock('../../ingestion/embedder.js', () => ({
  embedBatchOrThrow: mocks.embedBatchOrThrow,
}));

vi.mock('./store.js', () => ({
  saveFactDeterministic: mocks.saveFactDeterministic,
  findExactFact: mocks.findExactFact,
}));

import { saveAtomicMemories } from './direct.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (fn) => fn({ isTransaction: true }));
  mocks.embedBatchOrThrow.mockResolvedValue([
    Array(1024).fill(0.1),
    Array(1024).fill(0.2),
  ]);
  mocks.findExactFact.mockResolvedValue(null);
  mocks.saveFactDeterministic
    .mockResolvedValueOnce({ action: 'ADD', fact: { id: 11 } })
    .mockResolvedValueOnce({ action: 'SKIP', existing: { id: 12 } });
});

describe('saveAtomicMemories', () => {
  it('batch-embeds once, stores sequentially in one transaction, and reports counts', async () => {
    const result = await saveAtomicMemories([' first memory ', 'second memory']);

    expect(mocks.embedBatchOrThrow).toHaveBeenCalledTimes(1);
    expect(mocks.embedBatchOrThrow).toHaveBeenCalledWith(['first memory', 'second memory']);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.saveFactDeterministic).toHaveBeenCalledTimes(2);
    expect(result.counts).toEqual({ total: 2, added: 1, skipped: 1 });
  });

  it('returns without touching the embedder or database for empty input', async () => {
    const result = await saveAtomicMemories([' ', null, 42]);

    expect(result.counts).toEqual({ total: 0, added: 0, skipped: 0 });
    expect(mocks.embedBatchOrThrow).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('does not embed an exact duplicate already in storage', async () => {
    mocks.findExactFact.mockResolvedValue({ id: 21, uid: 'fact-known', content: 'Known fact' });

    const result = await saveAtomicMemories([' known fact ']);

    expect(result.counts).toEqual({ total: 1, added: 0, skipped: 1 });
    expect(mocks.embedBatchOrThrow).not.toHaveBeenCalled();
    expect(mocks.saveFactDeterministic).not.toHaveBeenCalled();
  });
});
