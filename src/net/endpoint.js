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

async function ensureRuntime() {
  if (iroh) return iroh;
  if (nodePromise) return nodePromise;

  await mkdir(SIGIL_IROH_DIR, { recursive: true });
  const secretKey = await getSecretKey();

  nodePromise = import('@number0/iroh').then(async ({ Iroh }) => {
    // Pass the persisted Ed25519 secret so the NodeID stays stable across
    // daemon restarts — that ID is what device rows on master devices
    // store for authorization.
    iroh = await Iroh.persistent(SIGIL_IROH_DIR, { secretKey });
    return iroh;
  });
  return nodePromise;
}

export async function getEndpoint() {
  const i = await ensureRuntime();
  return i.node.endpoint();
}

/**
 * Status snapshot. Includes node ID, listen addresses, and current relay
 * URL. Safe to expose to the GUI — the node ID is a public key, the
 * addresses tell other devices how to reach this one.
 */
export async function getNodeInfo() {
  const i = await ensureRuntime();
  const status = await i.node.status();
  return {
    nodeId: status.addr?.nodeId ?? null,
    relayUrl: status.addr?.relayUrl ?? null,
    addresses: status.addr?.addresses ?? [],
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
