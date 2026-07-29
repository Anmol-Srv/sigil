import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openSocketClient } from './socket-client.js';

const paths = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

describe('socket client caller context', () => {
  it('sends a privacy-safe project namespace with each RPC frame', async () => {
    const path = join(tmpdir(), `sigil-client-${randomUUID()}.sock`);
    paths.push(path);
    let received;
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (line) => {
        received = JSON.parse(line);
        socket.write(JSON.stringify({ id: received.id, ok: true, data: { pong: true } }) + '\n');
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });

    const client = await openSocketClient({
      path,
      projectScope: {
        kind: 'project',
        projectNamespace: 'project:1234567890abcdef12345678',
      },
    });
    const result = await client.call('ping', {});
    await client.close();
    await new Promise((resolve) => server.close(resolve));

    expect(result.data).toEqual({ pong: true });
    expect(received).toMatchObject({
      method: 'ping',
      scope: { projectNamespace: 'project:1234567890abcdef12345678' },
    });
    expect(JSON.stringify(received.scope)).not.toContain('/work/');
  });
});
