import { describe, expect, it, vi } from 'vitest';

import { createHttpController } from './http-controller.js';

describe('createHttpController', () => {
  it('does not load the HTTP/WebSocket stack until the GUI is explicitly started', () => {
    const loadServer = vi.fn();
    const controller = createHttpController({
      registry: {},
      log: vi.fn(),
      config: {},
      loadServer,
    });

    expect(controller.status()).toEqual({ running: false, url: null });
    expect(loadServer).not.toHaveBeenCalled();
  });

  it('coalesces concurrent starts and closes the one active server', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const startHttpServer = vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:7777/?t=test',
      close,
    });
    const loadServer = vi.fn().mockResolvedValue({ startHttpServer });
    const controller = createHttpController({
      registry: { list: vi.fn() },
      log: vi.fn(),
      config: { http: { host: '127.0.0.1', port: 7777 } },
      loadServer,
    });

    const [first, second] = await Promise.all([controller.start(), controller.start()]);

    expect(loadServer).toHaveBeenCalledTimes(1);
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(first.url).toBe(second.url);
    expect(controller.status()).toEqual({ running: true, url: first.url });

    await controller.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(controller.status()).toEqual({ running: false, url: null });
  });
});
