// A save runs a chain of LLM calls and routinely outlasts the 30s read budget.
// The client used ONE timeout per connection, so a write the daemon went on to
// complete reported "rpc timeout after 30000ms" to the caller — who retried,
// and the retry queued behind the still-running first attempt. Per-call
// timeouts let a write be judged by a write's budget.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSocketClient } from './socket-client.js';

let server;
let sockPath;

beforeAll(async () => {
  sockPath = join(mkdtempSync(join(tmpdir(), 'sigil-sock-')), 's');
  server = createServer((c) => {
    c.on('data', (buf) => {
      for (const line of String(buf).split('\n').filter(Boolean)) {
        const { id, method } = JSON.parse(line);
        // 'slow' never answers — it stands in for an in-flight write.
        if (method === 'slow') continue;
        c.write(`${JSON.stringify({ id, ok: true, data: { method } })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  rmSync(sockPath, { force: true });
});

describe('per-call rpc timeout', () => {
  it('uses the client default when no override is given', async () => {
    const c = await openSocketClient({ path: sockPath, timeoutMs: 60 });
    await expect(c.call('slow', {})).rejects.toThrow(/rpc timeout after 60ms/);
    await c.close();
  });

  it('lets a single call raise the budget above the client default', async () => {
    const c = await openSocketClient({ path: sockPath, timeoutMs: 40 });
    // Would have failed at 40ms; the override keeps it pending past that.
    const started = Date.now();
    await expect(c.call('slow', {}, { timeoutMs: 250 })).rejects.toThrow(/rpc timeout after 250ms/);
    expect(Date.now() - started).toBeGreaterThan(150);
    await c.close();
  });

  it('leaves normal calls unaffected', async () => {
    const c = await openSocketClient({ path: sockPath, timeoutMs: 1000 });
    const { data } = await c.call('search', {});
    expect(data.method).toBe('search');
    await c.close();
  });
});
