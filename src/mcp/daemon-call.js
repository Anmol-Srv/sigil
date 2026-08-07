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

// In-process dispatch override. When the MCP tools run INSIDE the daemon (the
// HTTP /mcp transport), there's no point opening a Unix socket back to our own
// process — set a direct dispatcher that calls the registry. Returns the
// unwrapped `data` (or throws) so it's drop-in for the socket path below.
let inProcessDispatch = null;
export function setInProcessDispatch(fn) { inProcessDispatch = fn; }

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
//
// ECLOSED is stamped by socket-client.js on BOTH stale-client conditions:
//   - "daemon connection closed" — the socket drops mid-call
//   - "client is closed"         — a call is made AFTER the socket already
//                                  closed (e.g. the daemon restarted under a
//                                  long-lived MCP session). Without this, that
//                                  second case never reconnected and every tool
//                                  call after a daemon restart failed.
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'EPIPE',
  'ECONNRESET',
  'ECLOSED',
]);
function isTransportError(err) {
  if (!err) return false;
  if (err.code && TRANSPORT_ERROR_CODES.has(err.code)) return true;
  // Fallback for older clients that don't stamp a code on these.
  return /^(daemon connection closed|client is closed)/i.test(err.message || '');
}

// `opts.timeoutMs` bounds THIS call only — the MCP server keeps one long-lived
// connection for every tool, so a generous write budget must not also slow down
// the detection of a hung read.
export async function daemonCall(method, params, opts) {
  if (inProcessDispatch) return inProcessDispatch(method, params ?? {});
  const client = await getClient();
  try {
    const { data } = await client.call(method, params ?? {}, opts);
    return data;
  } catch (err) {
    if (isTransportError(err)) {
      cachedClient = null;
      clientPromise = null;
      const retryClient = await getClient();
      const { data } = await retryClient.call(method, params ?? {}, opts);
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
