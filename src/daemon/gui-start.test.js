import { describe, expect, it, vi } from 'vitest';
import { createGuiStartHandler } from './index.js';

describe('GUI startup preference', () => {
  it('persists GUI availability only after the browser server starts', async () => {
    const start = vi.fn().mockResolvedValue({ started: true, url: 'http://127.0.0.1:7777/' });
    const persistHttpEnabled = vi.fn().mockResolvedValue(undefined);
    const config = { http: { enabled: false } };
    const handler = createGuiStartHandler({
      http: { start }, config, log: vi.fn(), persistHttpEnabled,
    });

    await expect(handler()).resolves.toEqual({ started: true, url: 'http://127.0.0.1:7777/' });
    expect(persistHttpEnabled).toHaveBeenCalledOnce();
    expect(config.http.enabled).toBe(true);
  });

  it('does not rewrite an already-persisted GUI preference', async () => {
    const persistHttpEnabled = vi.fn();
    const handler = createGuiStartHandler({
      http: { start: vi.fn().mockResolvedValue({ started: false, url: 'http://127.0.0.1:7777/' }) },
      config: { http: { enabled: true } },
      log: vi.fn(),
      persistHttpEnabled,
    });

    await handler();
    expect(persistHttpEnabled).not.toHaveBeenCalled();
  });

  it('keeps the current GUI usable when its preference cannot be persisted', async () => {
    const log = vi.fn();
    const handler = createGuiStartHandler({
      http: { start: vi.fn().mockResolvedValue({ started: true, url: 'http://127.0.0.1:7777/' }) },
      config: { http: { enabled: false } },
      log,
      persistHttpEnabled: vi.fn().mockRejectedValue(new Error('disk unavailable')),
    });

    await expect(handler()).resolves.toEqual({ started: true, url: 'http://127.0.0.1:7777/' });
    expect(log).toHaveBeenCalledWith('could not persist GUI preference: disk unavailable');
  });
});
