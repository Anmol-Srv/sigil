import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ correctFact: vi.fn(), recordTrace: vi.fn() }));

vi.mock('../../memory/facts/store.js', () => ({ correctFact: mocks.correctFact }));
vi.mock('../trace-store.js', () => ({ recordTrace: mocks.recordTrace }));

import { createRegistry } from '../rpc-registry.js';
import { registerCorrectFact } from './correct-fact.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordTrace.mockResolvedValue(undefined);
  mocks.correctFact.mockResolvedValue({
    unchanged: false,
    previous: { id: 1, uid: 'fact-old', content: 'Uses MySQL' },
    replacement: { id: 2, uid: 'fact-new', content: 'Uses PGlite locally', namespace: 'default' },
  });
});

describe('correctFact RPC', () => {
  it('requires a target and replacement', async () => {
    const registry = createRegistry();
    registerCorrectFact(registry);

    const response = await registry.dispatch('correctFact', { id: 'fact-old' });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('invalid_params');
    expect(mocks.correctFact).not.toHaveBeenCalled();
  });

  it('returns the preserved old fact and new replacement', async () => {
    const registry = createRegistry();
    registerCorrectFact(registry);

    const response = await registry.dispatch('correctFact', {
      id: 'fact-old',
      content: 'Uses PGlite locally',
    });

    expect(response.ok).toBe(true);
    expect(mocks.correctFact).toHaveBeenCalledWith('fact-old', 'Uses PGlite locally');
    expect(response.data.replacement.uid).toBe('fact-new');
    expect(mocks.recordTrace).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'correct', namespace: 'default',
      detail: { op: 'correctFact', previousFactId: 1, replacementFactId: 2 },
    }));
  });

  it('rejects document-sized replacement text', async () => {
    const registry = createRegistry();
    registerCorrectFact(registry);

    const response = await registry.dispatch('correctFact', {
      id: 'fact-old',
      content: 'x'.repeat(4_001),
    });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('invalid_params');
    expect(mocks.correctFact).not.toHaveBeenCalled();
  });
});
