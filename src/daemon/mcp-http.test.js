// Integration test for the daemon's MCP-over-HTTP transport (POST /mcp).
//
// Starts the real HTTP server with a MOCK registry (no DB, no daemon), then
// drives it with the real MCP SDK client over Streamable HTTP — proving the
// transport, the in-process daemonCall bridge, tool registration, and bearer
// auth all work end to end. Sandboxes $HOME so the gui.token lands in a temp
// dir, not the real ~/.sigil.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

let SANDBOX;
let httpServer;
let port;
let token;
let Client;
let StreamableHTTPClientTransport;

// Grab a free TCP port (bind :0, read the assigned port, release it).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// A registry stub: dispatch() mirrors the daemon contract ({ ok, data }). The
// MCP tools call daemonCall('status'|'search'|...) which the in-process bridge
// routes here.
const calls = [];
const registry = {
  list: () => ['status', 'search', 'remember'],
  dispatch: async (method, params) => {
    calls.push({ method, params });
    return { ok: true, data: { method, documents: 1, chunks: 2, facts: 3, note: 'mock' } };
  },
};

beforeAll(async () => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'sigil-mcphttp-test-'));
  process.env.HOME = SANDBOX; // gui-token writes ~/.sigil/gui.token here

  port = await freePort();
  const { startHttpServer } = await import('./http-server.js');
  httpServer = await startHttpServer({
    registry,
    log: () => {},
    config: { http: { host: '127.0.0.1', port } },
  });

  const { getGuiToken } = await import('./gui-token.js');
  token = await getGuiToken();

  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
}, 30000);

afterAll(async () => {
  if (httpServer) await httpServer.close();
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

function connectClient() {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'sigil-mcphttp-test', version: '1.0.0' });
  return { client, transport };
}

describe('daemon MCP-over-HTTP (POST /mcp)', () => {
  it('handshakes and lists the Sigil tools over HTTP', async () => {
    const { client, transport } = connectClient();
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // The deliberately small, user-facing memory surface.
      expect(names).toContain('status');
      expect(names).toContain('search');
      expect(names).toContain('remember');
      expect(names).toContain('prime');
      expect(names.sort()).toEqual([
        'correct', 'get_fact_context', 'ingest', 'prime',
        'remember', 'search', 'status',
      ]);
    } finally {
      await transport.close();
    }
  });

  it('routes a tool call through the in-process registry (no socket loopback)', async () => {
    calls.length = 0;
    const { client, transport } = connectClient();
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'status', arguments: {} });
      expect(res.content?.length).toBeGreaterThan(0);
      // The 'status' tool's daemonCall('status') reached our mock registry.
      expect(calls.some((c) => c.method === 'status')).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('rejects an unauthenticated /mcp request with 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
