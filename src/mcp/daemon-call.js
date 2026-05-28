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

// PR review #14: reconnect by err.code (set by socket-client on
// transport errors), not substring match of err.message — which would
// false-positive on any handler error that mentioned ENOENT/closed.
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'EPIPE',
  'ECONNRESET',
]);
function isTransportError(err) {
  if (!err) return false;
  if (err.code && TRANSPORT_ERROR_CODES.has(err.code)) return true;
  // The socket-client surfaces "daemon connection closed" as a plain
  // Error (no code) when the underlying socket drops mid-call.
  return /^daemon connection closed/i.test(err.message || '');
}

export async function daemonCall(method, params) {
  const client = await getClient();
  try {
    const { data } = await client.call(method, params ?? {});
    return data;
  } catch (err) {
    if (isTransportError(err)) {
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
