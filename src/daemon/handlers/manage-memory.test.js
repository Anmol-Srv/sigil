import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFacts: vi.fn(),
  listNamespaces: vi.fn(),
  deleteNamespace: vi.fn(),
  listDocuments: vi.fn(),
}));

vi.mock('../../memory/facts/store.js', () => ({
  listFacts: mocks.listFacts,
  listNamespaces: mocks.listNamespaces,
  deleteNamespace: mocks.deleteNamespace,
}));
vi.mock('../../memory/documents/store.js', () => ({
  listDocuments: mocks.listDocuments,
}));
vi.mock('../../config.js', () => ({
  default: { defaults: { namespace: 'default' } },
}));

import { createRegistry } from '../rpc-registry.js';
import { registerManageMemory } from './manage-memory.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listFacts.mockResolvedValue([
    { uid: 'fact-1', content: 'Use PGlite', category: 'decision', confidence: 'high', importance: 'normal' },
  ]);
  mocks.listDocuments.mockResolvedValue([
    { sourcePath: '/notes.md', title: 'Notes', sourceType: 'markdown', chunkCount: 2, factCount: 1 },
  ]);
  mocks.listNamespaces.mockResolvedValue([{ namespace: 'default', factCount: 1 }]);
  mocks.deleteNamespace.mockResolvedValue({
    factsDeleted: 1, chunksDeleted: 2, docsDeleted: 1, entitiesDeleted: 4,
  });
});

describe('memory-management RPCs', () => {
  it('exports through the daemon and exposes only supported memory fields', async () => {
    const registry = createRegistry();
    registerManageMemory(registry);

    const response = await registry.dispatch('exportData', {});

    expect(response.ok).toBe(true);
    expect(mocks.listFacts).toHaveBeenCalledWith({ namespace: 'default', limit: 10_000 });
    expect(response.data.documents[0]).not.toHaveProperty('sourceMetadata');
    expect(response.data).not.toHaveProperty('entities');
  });

  it('requires confirmation at the RPC boundary before deleting a namespace', async () => {
    const registry = createRegistry();
    registerManageMemory(registry);

    const denied = await registry.dispatch('deleteNamespace', { namespace: 'default' });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe('confirmation_required');
    expect(mocks.deleteNamespace).not.toHaveBeenCalled();

    const deleted = await registry.dispatch('deleteNamespace', { namespace: 'default', confirm: true });
    expect(deleted.ok).toBe(true);
    expect(deleted.data).toEqual({
      namespace: 'default',
      factsDeleted: 1,
      chunksDeleted: 2,
      docsDeleted: 1,
    });
  });
});
