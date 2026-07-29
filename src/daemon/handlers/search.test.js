import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  recordTrace: vi.fn(),
  recordPromptRecall: vi.fn(),
}));

vi.mock('../../memory/search/hybrid.js', () => ({ search: mocks.search }));
vi.mock('../../config.js', () => ({ default: { defaults: { namespace: 'default' } } }));
vi.mock('../trace-store.js', () => ({ recordTrace: mocks.recordTrace }));
vi.mock('../recall-observatory.js', () => ({ recordPromptRecall: mocks.recordPromptRecall }));

import { createRegistry } from '../rpc-registry.js';
import { registerSearch } from './search.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockResolvedValue({
    facts: [{ id: 1, uid: 'fact-1', content: 'Use PGlite', similarity: 0.9, rrfScore: 1 }],
    chunks: [],
    _trace: { durationMs: 3, ranking: { model: 'RRF(vector + keyword)' } },
  });
});

describe('search RPC', () => {
  it('returns ranking evidence without persisting a read-side trace', async () => {
    const registry = createRegistry();
    registerSearch(registry);

    const response = await registry.dispatch('search', { query: 'local database' });

    expect(response.ok).toBe(true);
    expect(response.data.trace.ranking.model).toBe('RRF(vector + keyword)');
    expect(mocks.recordTrace).not.toHaveBeenCalled();
    expect(mocks.recordPromptRecall).not.toHaveBeenCalled();
  });

  it('records bounded runtime evidence only when a prompt hook explicitly asks', async () => {
    const registry = createRegistry();
    registerSearch(registry);

    const response = await registry.dispatch(
      'search',
      { query: 'local database', observePromptRecall: true },
      { transport: 'socket', agent: 'codex' },
    );

    expect(response.ok).toBe(true);
    expect(mocks.recordTrace).not.toHaveBeenCalled();
    expect(mocks.recordPromptRecall).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex', namespace: 'default', resultCount: 1,
    }));
    expect(mocks.recordPromptRecall.mock.calls[0][0]).not.toHaveProperty('query');
  });

  it('searches a caller project before shared memory and labels the result scope', async () => {
    const registry = createRegistry();
    registerSearch(registry);
    const projectNamespace = 'project:1234567890abcdef12345678';

    const response = await registry.dispatch(
      'search',
      { query: 'project decision' },
      { transport: 'socket', agent: 'codex', scope: { projectNamespace } },
    );

    expect(response.ok).toBe(true);
    expect(response.data.scope).toBe('project');
    expect(response.data.namespaces).toEqual([projectNamespace, 'default']);
    expect(mocks.search).toHaveBeenCalledWith('project decision', expect.objectContaining({
      namespaceTiers: [[projectNamespace], ['default']],
    }));
  });

  it('rejects an oversized query before embedding it', async () => {
    const registry = createRegistry();
    registerSearch(registry);

    const response = await registry.dispatch('search', { query: 'x'.repeat(8_001) });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('invalid_params');
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
