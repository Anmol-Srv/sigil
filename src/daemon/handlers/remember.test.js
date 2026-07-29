import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveAtomicMemories: vi.fn(),
  recordTrace: vi.fn(),
}));

vi.mock('../../memory/facts/direct.js', () => ({
  saveAtomicMemories: mocks.saveAtomicMemories,
}));

vi.mock('../trace-store.js', () => ({
  recordTrace: mocks.recordTrace,
}));

import { createRegistry } from '../rpc-registry.js';
import { registerRemember } from './remember.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveAtomicMemories.mockResolvedValue({
    counts: { total: 2, added: 1, skipped: 1 },
    results: [
      { action: 'ADD', fact: { id: 1 }, dedup: { decision: 'deterministic-add' } },
      { action: 'SKIP', existing: { id: 2 }, dedup: { decision: 'deterministic-duplicate' } },
    ],
  });
  mocks.recordTrace.mockResolvedValue(undefined);
});

describe('remember RPC', () => {
  it('stores supplied text directly without routing through document ingestion', async () => {
    const registry = createRegistry();
    registerRemember(registry);

    const response = await registry.dispatch('remember', {
      facts: ['Use PGlite locally', 'Use PGlite locally'],
      namespace: 'project',
    });

    expect(response.ok).toBe(true);
    expect(mocks.saveAtomicMemories).toHaveBeenCalledWith(
      ['Use PGlite locally', 'Use PGlite locally'],
      { namespace: 'project' },
    );
    expect(response.data).toEqual({
      added: 1,
      alreadyKnown: 1,
      namespace: 'project',
    });
  });

  it('rejects an empty memory list before touching storage', async () => {
    const registry = createRegistry();
    registerRemember(registry);

    const response = await registry.dispatch('remember', { facts: [] });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('invalid_params');
    expect(mocks.saveAtomicMemories).not.toHaveBeenCalled();
  });

  it('uses the caller project for an implicit write', async () => {
    const registry = createRegistry();
    registerRemember(registry);
    const projectNamespace = 'project:1234567890abcdef12345678';

    const response = await registry.dispatch(
      'remember',
      { facts: ['Keep project decisions close to the codebase'] },
      { transport: 'socket', agent: 'codex', scope: { projectNamespace } },
    );

    expect(response.ok).toBe(true);
    expect(response.data.namespace).toBe(projectNamespace);
    expect(mocks.saveAtomicMemories).toHaveBeenCalledWith(
      ['Keep project decisions close to the codebase'],
      { namespace: projectNamespace },
    );
  });

  it('rejects oversized batches and document-sized facts', async () => {
    const registry = createRegistry();
    registerRemember(registry);

    const tooMany = await registry.dispatch('remember', { facts: Array(101).fill('fact') });
    const tooLarge = await registry.dispatch('remember', { facts: ['x'.repeat(4_001)] });

    expect(tooMany.error.code).toBe('invalid_params');
    expect(tooLarge.error.code).toBe('invalid_params');
    expect(mocks.saveAtomicMemories).not.toHaveBeenCalled();
  });
});
