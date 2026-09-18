import { beforeEach, describe, expect, it, vi } from 'vitest';

const { config, patchConfig } = vi.hoisted(() => ({
  config: {
    jev: {
      enabled: false,
      apiKey: null,
      model: 'jev-latest',
      maxCandidates: 12,
      minScore: 0.55,
      timeoutMs: 10_000,
    },
  },
  patchConfig: vi.fn(),
}));

vi.mock('../../setup/config-store.js', () => ({
  getConfig: () => config,
  patchConfig,
}));
import { registerJev } from './jev.js';

const probeImpl = vi.fn();

function handlers() {
  const map = new Map();
  registerJev({ register: (name, fn) => map.set(name, fn) }, { probeImpl });
  return map;
}

beforeEach(() => {
  config.jev.apiKey = null;
  config.jev.enabled = false;
  patchConfig.mockReset();
  probeImpl.mockReset().mockResolvedValue({ model: 'jev-1.13.0', models: ['jev-1.13.0'] });
});

describe('Jev configuration RPCs', () => {
  it('exposes status without ever returning the credential', async () => {
    config.jev.apiKey = 'secret-never-returned';
    const result = await handlers().get('jev.status')();

    expect(result).toMatchObject({ configured: true, enabled: false, ready: false });
    expect(JSON.stringify(result)).not.toContain('secret-never-returned');
  });

  it('verifies a key before saving it and never echoes it back', async () => {
    const result = await handlers().get('jev.configure')({ apiKey: 'test-key', model: 'jev-1.13.0' });

    expect(probeImpl).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
    expect(patchConfig).toHaveBeenCalledWith('jev', expect.objectContaining({ apiKey: 'test-key' }));
    expect(result).toMatchObject({ configured: true, saved: true, verified: true });
    expect(JSON.stringify(result)).not.toContain('test-key');
  });

  it('refuses to save a key Jev rejected', async () => {
    probeImpl.mockRejectedValue(Object.assign(new Error('Jev credential check failed (401)'), { status: 401 }));

    await expect(handlers().get('jev.configure')({ apiKey: 'bad-key' })).rejects.toThrow(/rejected that API key/);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('still saves when verification fails for a non-auth reason, flagged unverified', async () => {
    probeImpl.mockRejectedValue(Object.assign(new Error('fetch failed'), { status: null }));

    const result = await handlers().get('jev.configure')({ apiKey: 'test-key' });

    expect(patchConfig).toHaveBeenCalled();
    expect(result).toMatchObject({ saved: true, verified: false });
    expect(result.warning).toMatch(/could not be verified/);
  });
});
