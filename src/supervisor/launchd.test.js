import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sh.js', () => ({ sh: vi.fn() }));

import { sh } from './sh.js';
import { LABEL, refresh, releaseDaemonForServiceReload, restart } from './launchd.js';

const target = `gui/${process.getuid()}/${LABEL}`;

describe('launchd restart', () => {
  beforeEach(() => sh.mockReset());

  it('boots out and releases the live daemon before reloading the service', async () => {
    sh
      .mockReturnValueOnce({ code: 0 })
      .mockReturnValueOnce({ code: 0 })
      .mockReturnValueOnce({ code: 0 });

    const release = vi.fn().mockResolvedValue(true);
    const result = await restart({ release });
    expect(sh).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', target]);
    expect(release).toHaveBeenCalledOnce();
    expect(sh).toHaveBeenNthCalledWith(2, 'launchctl', ['bootstrap', `gui/${process.getuid()}`, expect.any(String)]);
    expect(sh).toHaveBeenNthCalledWith(3, 'launchctl', ['kickstart', target]);
    expect(result).toEqual({ ok: true, manager: 'launchd' });
  });

  it('releases the daemon gracefully before using SIGKILL as a last resort', async () => {
    const signals = [];
    let running = true;
    await expect(releaseDaemonForServiceReload({
      readPid: vi.fn().mockResolvedValue(42),
      alive: vi.fn(() => running),
      signal: (pid, value) => { signals.push([pid, value]); if (value === 'SIGTERM') running = false; },
      sleep: vi.fn(),
    })).resolves.toBe(true);
    expect(signals).toEqual([[42, 'SIGTERM']]);
  });

  it('falls back to SIGKILL only after the bounded graceful wait', async () => {
    const signals = [];
    let running = true;
    let clock = 0;
    await expect(releaseDaemonForServiceReload({
      readPid: vi.fn().mockResolvedValue(42),
      alive: vi.fn(() => running),
      signal: (pid, value) => { signals.push([pid, value]); if (value === 'SIGKILL') running = false; },
      sleep: vi.fn(async () => { clock += 5_000; }),
      now: () => clock,
    })).resolves.toBe(true);
    expect(signals).toEqual([[42, 'SIGTERM'], [42, 'SIGKILL']]);
  });

  it('uses the legacy kickstart recovery only when reload fails', async () => {
    sh
      .mockReturnValueOnce({ code: 0 })
      .mockReturnValueOnce({ code: 1 })
      .mockReturnValueOnce({ code: 0 });

    await expect(restart({ release: vi.fn().mockResolvedValue(true) })).resolves.toEqual({ ok: true, manager: 'launchd' });
    expect(sh).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', target]);
    expect(sh).toHaveBeenNthCalledWith(2, 'launchctl', ['bootstrap', `gui/${process.getuid()}`, expect.any(String)]);
    expect(sh).toHaveBeenNthCalledWith(3, 'launchctl', ['kickstart', '-k', target]);
  });

  it('writes the current service unit before reloading its managed daemon', async () => {
    const calls = [];
    const result = await refresh({
      writeUnit: () => calls.push('write'),
      restartService: async () => { calls.push('restart'); return { ok: true, manager: 'launchd' }; },
    });
    expect(calls).toEqual(['write', 'restart']);
    expect(result).toEqual({ ok: true, manager: 'launchd' });
  });
});
