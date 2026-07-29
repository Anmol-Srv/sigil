import { describe, expect, it, vi } from 'vitest';

import { createClientRegistry } from './index.js';

const manifest = {
  version: 1,
  capabilities: { mcp: true, automaticRecall: false, instructions: false, healthCheck: true },
  ownedPaths: ['~/.example/config.json'],
};

describe('built-in adapter registry', () => {
  it('adds manifest metadata and exposes a dry-run plan plus apply wrapper', async () => {
    const install = vi.fn().mockResolvedValue({ actions: [{ action: 'create', path: '/tmp/example' }] });
    const registry = createClientRegistry({
      adapters: [{
        id: 'example',
        manifest,
        load: async () => ({
          meta: { id: 'example', label: 'Example', hint: 'test' },
          detect: async () => true,
          install,
          uninstall: async () => ({ actions: [] }),
          verify: async () => ({ installed: true }),
        }),
      }],
    });

    const [adapter] = await registry.listClients();
    expect(adapter.manifest).toEqual({ id: 'example', ...manifest });
    expect(adapter.capabilities).toEqual(manifest.capabilities);

    await adapter.plan();
    await adapter.apply();
    expect(install).toHaveBeenNthCalledWith(1, { dryRun: true });
    expect(install).toHaveBeenNthCalledWith(2, { dryRun: false });
  });

  it('rejects an adapter whose module does not match its allowlisted manifest', async () => {
    const registry = createClientRegistry({
      adapters: [{
        id: 'example', manifest,
        load: async () => ({ meta: { id: 'different' } }),
      }],
    });

    await expect(registry.listClients()).rejects.toThrow('missing the adapter contract or manifest');
  });
});
