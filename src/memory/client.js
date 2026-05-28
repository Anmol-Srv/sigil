/**
 * MemoryClient — uniform interface for memory operations regardless of
 * whether they execute locally (Postgres on this device) or remotely
 * (Iroh RPC to a paired master).
 *
 * Mode selection:
 *   solo / master  → LocalClient  (in-process registry dispatch)
 *   follower       → LocalClient  (writes go to local DB too; sync layer
 *                                  in PR 17 cross-publishes them)
 *   lite-follower  → RemoteClient (no local DB at all — every read and
 *                                  write proxied to master)
 *
 * Handlers that want to delegate ("send this to master if I'm a
 * lite-follower, else do it myself") import getMemoryClient(); the
 * concrete implementation is decided at first call.
 */
import config from '../config.js';

let cached = null;

export async function getMemoryClient() {
  if (cached) return cached;
  const mode = config.network.mode;
  if (mode === 'lite-follower') {
    const { createRemoteClient } = await import('./remote-client.js');
    cached = await createRemoteClient();
  } else {
    const { createLocalClient } = await import('./local-client.js');
    cached = createLocalClient();
  }
  return cached;
}

/** Reset the cached client. Useful for tests and for mode flips. */
export function resetMemoryClient() {
  if (cached?.close) cached.close().catch(() => {});
  cached = null;
}
