import { describe, expect, it, vi } from 'vitest';

import { restartDaemonLifecycle } from './daemon.js';

describe('daemon restart lifecycle', () => {
  it('refreshes the OS supervisor when automatic start owns the daemon', async () => {
    const refreshService = vi.fn().mockResolvedValue({ ok: true, manager: 'launchd' });
    const stop = vi.fn();
    const start = vi.fn();

    await expect(restartDaemonLifecycle({
      isServiceInstalled: vi.fn().mockResolvedValue(true),
      refreshService,
      stop,
      start,
    })).resolves.toEqual({ managed: true, manager: 'launchd' });

    expect(refreshService).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('fails clearly when the managed service cannot restart', async () => {
    await expect(restartDaemonLifecycle({
      isServiceInstalled: vi.fn().mockResolvedValue(true),
      refreshService: vi.fn().mockResolvedValue({ ok: false, manager: 'launchd' }),
      stop: vi.fn(),
      start: vi.fn(),
    })).rejects.toThrow('could not restart the launchd Sigil service');
  });

  it('uses stop then start only when automatic start is disabled', async () => {
    const calls = [];
    await expect(restartDaemonLifecycle({
      isServiceInstalled: vi.fn().mockResolvedValue(false),
      refreshService: vi.fn(),
      stop: vi.fn(async () => calls.push('stop')),
      start: vi.fn(async () => calls.push('start')),
      sleep: vi.fn(async () => calls.push('sleep')),
    })).resolves.toEqual({ managed: false });

    expect(calls).toEqual(['stop', 'sleep', 'start']);
  });
});
