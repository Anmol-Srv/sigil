import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerSearchTool } from './tools/search.js';
import { registerSearchEntityTool } from './tools/search-entity.js';
import { registerTraverseGraphTool } from './tools/traverse-graph.js';
import { registerGetFactContextTool } from './tools/get-fact-context.js';
import { registerGetEntityContextTool } from './tools/get-entity-context.js';
import { registerStatusTool } from './tools/status.js';
import { registerIngestTool } from './tools/ingest.js';
import { registerListPodsTool } from './tools/list-pods.js';
import { registerGetPodTool } from './tools/get-pod.js';

// Agent provenance: writes from MCP clients (Cursor, Codex, etc.) are tagged
// 'mcp'. The socket client forwards this in each request envelope so the
// daemon stamps created_by_agent. An explicitly-set SIGIL_AGENT wins.
if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'mcp';

function createMcpServer() {
  const server = new McpServer({
    name: 'sigil',
    version: '0.2.0',
  });

  // Retrieval
  registerSearchTool(server);
  registerSearchEntityTool(server);

  // Traversal
  registerTraverseGraphTool(server);

  // Detail
  registerGetFactContextTool(server);
  registerGetEntityContextTool(server);
  registerGetPodTool(server);

  // Discovery
  registerListPodsTool(server);

  // Operations
  registerStatusTool(server);
  registerIngestTool(server);

  return server;
}

async function startMcp() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

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
