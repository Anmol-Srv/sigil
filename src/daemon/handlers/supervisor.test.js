import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serviceStatus: vi.fn(),
  restartService: vi.fn(),
  installServiceUnit: vi.fn(),
  uninstallService: vi.fn(),
}));

vi.mock('../../supervisor/index.js', () => mocks);
vi.mock('../registry-holder.js', () => ({ getDbHealth: () => null }));

import { createRegistry } from '../rpc-registry.js';
import { registerSupervisor } from './supervisor.js';

describe('supervisor RPCs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('refuses a restart until automatic start is installed', async () => {
    mocks.serviceStatus.mockResolvedValue({ supervisor: { installed: false } });
    const registry = createRegistry();
    registerSupervisor(registry);

    const result = await registry.dispatch('serviceRestart');

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('service_not_installed');
    expect(mocks.restartService).not.toHaveBeenCalled();
  });

  it('restarts the installed supervised runtime', async () => {
    mocks.serviceStatus.mockResolvedValue({ supervisor: { installed: true } });
    mocks.restartService.mockResolvedValue({ ok: true, manager: 'launchd' });
    const registry = createRegistry();
    registerSupervisor(registry);

    await expect(registry.dispatch('serviceRestart')).resolves.toEqual({
      ok: true,
      data: { ok: true, manager: 'launchd' },
    });
  });
});
