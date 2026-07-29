import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findByUid: vi.fn() }));

vi.mock('../../memory/facts/store.js', () => ({ findByUid: mocks.findByUid }));
vi.mock('../../db/cortex.js', () => ({ default: vi.fn() }));

import { createRegistry } from '../rpc-registry.js';
import { registerGetFactContext } from './get-fact-context.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByUid.mockResolvedValue({
    id: 7,
    uid: 'fact-7',
    content: 'Use shared filters.',
    category: 'decision',
    confidence: 'high',
    status: 'active',
    namespace: 'default',
    sourceSection: 'direct',
    createdByAgent: 'codex',
    sourceDocumentIds: [],
  });
});

describe('getFactContext RPC', () => {
  it('returns writer provenance and shared scope with the fact', async () => {
    const registry = createRegistry();
    registerGetFactContext(registry);

    const response = await registry.dispatch('getFactContext', { uid: 'fact-7' });

    expect(response.ok).toBe(true);
    expect(response.data.fact).toMatchObject({
      uid: 'fact-7', agent: 'codex', namespace: 'default',
    });
  });
});
