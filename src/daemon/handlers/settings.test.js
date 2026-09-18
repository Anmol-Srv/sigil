import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: { jev: { apiKey: null, enabled: false, model: 'jev-latest' } },
  patchConfig: vi.fn(),
}));

vi.mock('../../setup/config-store.js', () => ({
  getConfig: () => state.config,
  patchConfig: (...args) => state.patchConfig(...args),
}));

import { registerSettings } from './settings.js';

function settingsSet() {
  const handlers = new Map();
  registerSettings({ register: (name, handler) => handlers.set(name, handler) });
  return handlers.get('settings.set');
}

describe('settings.set Jev switch', () => {
  beforeEach(() => {
    state.config.jev.apiKey = null;
    state.config.jev.enabled = false;
    state.patchConfig.mockReset();
  });

  it('does not expose a misleading enabled state without a saved key', async () => {
    await expect(settingsSet()({ updates: { 'jev.enabled': true } })).resolves.toEqual({
      ok: false,
      errors: { 'jev.enabled': 'Save a Jev API key in the Connect Jev panel above before enabling this.' },
    });
    expect(state.patchConfig).not.toHaveBeenCalled();
  });

  it('persists the switch when a key is configured', async () => {
    state.config.jev.apiKey = 'saved-key';
    const result = await settingsSet()({ updates: { 'jev.enabled': true } });
    expect(result).toMatchObject({ ok: true, changed: ['jev.enabled'] });
    expect(state.patchConfig).toHaveBeenCalledWith('jev', expect.objectContaining({ enabled: true }));
  });
});
