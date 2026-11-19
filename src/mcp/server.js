import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from './build-server.js';

// Agent provenance: writes from MCP clients (Cursor, Codex, etc.) are tagged
// 'mcp'. The socket client forwards this in each request envelope so the
// daemon stamps created_by_agent. An explicitly-set SIGIL_AGENT wins.
// NB: this mutation lives in the stdio entry ONLY — createMcpServer is imported
// from build-server.js precisely so the daemon doesn't inherit this default.
if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'mcp';

async function startMcp() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Each connector names its agent in the MCP entry's env (SIGIL_AGENT). The
  // agent starting this server is proof its MCP config is live.
  const agent = process.env.SIGIL_AGENT;
  if (agent && agent !== 'mcp') {
    import('../hooks/host.js').then(({ markSeen }) => markSeen(agent, 'start', 'mcp')).catch(() => {});
  }

  // Best-effort: close the shared daemon socket when the MCP client
  // disconnects so we don't leak a half-open socket on the daemon side.
  const { closeDaemonConnection } = await import('./daemon-call.js');
  const cleanup = () => { closeDaemonConnection().catch(() => {}); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('beforeExit', cleanup);

  return server;
}

export { createMcpServer, startMcp };
