/**
 * Worker MCP server — the out-of-band return channel for a managed session.
 *
 * A managed `claude` worker is launched with `--strict-mcp-config --mcp-config`
 * pointing ONLY at this server, so the worker sees exactly two tools and nothing
 * from the public 9-tool memory surface:
 *
 *   get_task      → pull this worker's assigned task   {reqId, prompt} | {empty}
 *   submit_result → hand the result back                {reqId, result}
 *
 * Both tools forward to the daemon over its Unix socket (the daemon launched us,
 * so it is definitely running — we connect to the EXISTING daemon and never
 * spawn one). The daemon's RPC handlers correlate the reqId back to the awaiting
 * caller via the SessionManager.
 *
 * Identity comes from env injected at launch (see drivers/claude.js): each
 * worker's MCP server knows which worker it serves, so get_task pulls the right
 * task and submit_result completes the right one.
 *
 * This file is a process ENTRY (spawned by the worker), not imported by the
 * daemon — keeping the two internal tools physically off build-server.js
 * guarantees they can never leak onto the public MCP surface.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { openSocketClient } from '../clients/socket-client.js';
import { textResponse } from './utils.js';

const WORKER_ID = process.env.SIGIL_WORKER_ID || 'unknown';

// One lazily-opened socket to the daemon, reused for this worker's lifetime.
let clientPromise = null;
async function rpc(method, params) {
  if (!clientPromise) {
    clientPromise = openSocketClient({ timeoutMs: 10_000 }).catch((e) => { clientPromise = null; throw e; });
  }
  const client = await clientPromise;
  const { data } = await client.call(method, params);
  return data;
}

export function createWorkerMcpServer() {
  const server = new McpServer({ name: 'sigil-worker', version: '0.1.0' });

  server.tool(
    'get_task',
    'Pull the next task assigned to this worker. Returns {reqId, prompt} to '
    + 'process, or {empty:true} when there is nothing to do (then stop and wait).',
    {},
    async () => {
      const task = await rpc('managedSession.getTask', { workerId: WORKER_ID });
      return textResponse(JSON.stringify(task));
    },
  );

  server.tool(
    'submit_result',
    'Return the result for a task. Call exactly once per task with the reqId '
    + 'from get_task and your answer as a string.',
    {
      reqId: z.string().describe('The reqId from get_task this result is for.'),
      result: z.string().describe('Your answer for the task, as a plain string.'),
    },
    async ({ reqId, result }) => {
      const r = await rpc('managedSession.submitResult', { workerId: WORKER_ID, reqId, result });
      return textResponse(JSON.stringify(r));
    },
  );

  return server;
}

async function startWorkerMcp() {
  const server = createWorkerMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = async () => {
    try { const c = await clientPromise; if (c) await c.close(); } catch { /* ignore */ }
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('beforeExit', cleanup);
  return server;
}

// Process entry: launched by a managed worker via --mcp-config.
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkerMcp().catch((err) => {
    process.stderr.write(`[sigil-worker-mcp] fatal: ${err.message}\n`);
    process.exit(1);
  });
}

export { startWorkerMcp };
