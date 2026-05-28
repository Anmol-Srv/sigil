/**
 * Long-lived daemon connection for the MCP server process.
 *
 * Each MCP client (Claude Code, Cursor, ...) spawns one MCP server process,
 * which keeps a single socket open to sigild for its entire lifetime. Tool
 * calls reuse this connection — there is no per-tool-call connection cost
 * beyond ~1ms of write/read.
 *
 * The connection is opened lazily on the first call so the MCP server can
 * register its tools (and respond to `tools/list`) without requiring the
 * daemon to be reachable yet.
 */
import { connectOrStartDaemon } from '../clients/auto-spawn.js';

let clientPromise = null;
let cachedClient = null;

async function getClient() {
  if (cachedClient) return cachedClient;
  if (!clientPromise) {
    clientPromise = connectOrStartDaemon({ quiet: true })
      .then((c) => { cachedClient = c; return c; })
      .catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

export async function daemonCall(method, params) {
  const client = await getClient();
  try {
    const { data } = await client.call(method, params ?? {});
    return data;
  } catch (err) {
    // If the daemon went away mid-call, try once to reconnect.
    if (/closed|ECONNREFUSED|ENOENT/i.test(err.message || '')) {
      cachedClient = null;
      clientPromise = null;
      const retryClient = await getClient();
      const { data } = await retryClient.call(method, params ?? {});
      return data;
    }
    throw err;
  }
}

/** Close the shared connection — called on MCP server shutdown. */
export async function closeDaemonConnection() {
  const c = cachedClient;
  cachedClient = null;
  clientPromise = null;
  if (c) await c.close();
}
