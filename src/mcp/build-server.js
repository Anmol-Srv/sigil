/**
 * Builds the Sigil McpServer (tool registrations only) — NO transport, NO
 * process-wide side effects.
 *
 * This is split out from server.js so it can be imported by BOTH:
 *   - src/mcp/server.js   → the stdio entry (spawned per MCP client)
 *   - src/daemon/mcp-http.js → the daemon's HTTP /mcp transport
 *
 * Keeping it side-effect-free matters: server.js sets a default
 * `process.env.SIGIL_AGENT = 'mcp'`, which is correct for the stdio process but
 * must NOT leak into the daemon process (the daemon stamps agent per-request).
 * Importing from here gives the daemon the tools without that global mutation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerSearchTool } from './tools/search.js';
import { registerSearchEntityTool } from './tools/search-entity.js';
import { registerTraverseGraphTool } from './tools/traverse-graph.js';
import { registerGetFactContextTool } from './tools/get-fact-context.js';
import { registerGetEntityContextTool } from './tools/get-entity-context.js';
import { registerStatusTool } from './tools/status.js';
import { registerIngestTool } from './tools/ingest.js';
import { registerRememberTool } from './tools/remember.js';
import { registerListPodsTool } from './tools/list-pods.js';
import { registerGetPodTool } from './tools/get-pod.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerPrimeTool } from './tools/prime.js';

export function createMcpServer() {
  const server = new McpServer({
    name: 'sigil',
    version: '0.2.0',
  });

  // Session start — call first; primes memory for clients without hooks.
  registerPrimeTool(server);

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
  // Whole documents, on demand — list to find one, get to read it in full.
  registerDocumentTools(server);

  // Operations
  registerStatusTool(server);
  registerIngestTool(server);
  registerRememberTool(server);

  return server;
}
