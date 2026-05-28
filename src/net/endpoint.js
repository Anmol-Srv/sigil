/**
 * Iroh Endpoint singleton.
 *
 * Wraps `@number0/iroh` so the rest of the codebase doesn't need to know
 * about Iroh's exact API surface (which is still pre-1.0). One Iroh
 * Node per process — its identity directory at ~/.sigil/iroh/ persists
 * the Ed25519 keypair, blob store, and relay discovery state.
 *
 * Exposes:
 *   getEndpoint()         → lazy-init the underlying Iroh runtime
 *   getNodeInfo()         → { nodeId, addresses, relayUrl }
 *   shutdownEndpoint()    → graceful shutdown, called from the daemon
 *
 * In PR 7 we only start the runtime and expose identity. Accept-side
 * (ALPN handlers for sigil/rpc/1 and sigil/pair/1) lands in PR 10.
 */
import { mkdir } from 'node:fs/promises';

import { SIGIL_IROH_DIR } from '../lib/paths.js';
import { getSecretKey } from './identity.js';

let iroh = null;
let nodePromise = null;
const pendingProtocols = new Map();

/**
 * Register an accept-side handler for an ALPN. Must be called BEFORE
 * the Iroh runtime starts (i.e. before any getEndpoint / getNodeInfo
 * call). Multiple ALPNs can be registered.
 *
 * The handler signature mirrors Iroh's: (err, conn) => Promise<void>.
 */
export function registerProtocol(alpn, handler) {
  if (iroh || nodePromise) {
    throw new Error(`registerProtocol("${alpn}"): runtime already started; register before first getEndpoint() call`);
  }
  pendingProtocols.set(alpn, handler);
}

async function ensureRuntime() {
  if (iroh) return iroh;
  if (nodePromise) return nodePromise;

  await mkdir(SIGIL_IROH_DIR, { recursive: true });
  const secretKey = await getSecretKey();

  nodePromise = import('@number0/iroh').then(async ({ Iroh }) => {
    // PR review #17: use the ALPN string directly as the key. We were
    // previously setting protocols[Buffer.from(alpn)] which coerces to
    // toString('utf8') — works today but only because the resulting
    // string happens to equal the ALPN. Using the string is what the
    // iroh test fixture documents.
    const protocols = {};
    for (const [alpn, handler] of pendingProtocols) {
      protocols[alpn] = (err, ep) => {
        if (err) throw err;
        return {
          accept: handler,
          shutdown: () => {},
        };
      };
    }

    iroh = await Iroh.persistent(SIGIL_IROH_DIR, {
      secretKey,
      protocols: Object.keys(protocols).length ? protocols : undefined,
    });
    return iroh;
  });
  return nodePromise;
}

export async function getEndpoint() {
  const i = await ensureRuntime();
  return i.node.endpoint();
}

/** Dial a remote NodeAddr on a given ALPN. */
export async function dial(nodeAddr, alpn) {
  const ep = await getEndpoint();
  return ep.connect(nodeAddr, Buffer.from(alpn));
}

/** Get this node's full address (includes relay + addresses). */
export async function getNodeAddr() {
  const i = await ensureRuntime();
  return i.net.nodeAddr();
}

/**
 * Status snapshot. Includes node ID, listen addresses, and current relay
 * URL. Safe to expose to the GUI — the node ID is a public key, the
 * addresses tell other devices how to reach this one.
 *
 * PR review #21: fail loudly if Iroh's status shape changes — pre-1.0
 * the API isn't frozen. A silent `nodeId: null` would propagate into
 * the pair flow as broken handshakes.
 */
export async function getNodeInfo() {
  const i = await ensureRuntime();
  const status = await i.node.status();
  if (!status || typeof status !== 'object') {
    throw new Error('iroh: node.status() returned non-object — Iroh API shape changed?');
  }
  if (!status.addr || typeof status.addr.nodeId !== 'string') {
    throw new Error(`iroh: node.status().addr.nodeId missing (got ${JSON.stringify(status).slice(0, 200)}) — Iroh API shape changed?`);
  }
  return {
    nodeId: status.addr.nodeId,
    relayUrl: status.addr.relayUrl ?? null,
    addresses: status.addr.addresses ?? [],
    version: status.version ?? null,
    listenAddrs: status.listenAddrs ?? [],
  };
}

export async function shutdownEndpoint() {
  if (!iroh) return;
  const i = iroh;
  iroh = null;
  nodePromise = null;
  try { await i.node.shutdown(false); } catch { /* best effort */ }
}
