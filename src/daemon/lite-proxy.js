/**
 * lite-follower mode: redirect data-touching RPC methods to master.
 *
 * Local methods that should NOT be proxied (they are about *this* device):
 *   ping, mode, nodeInfo, readEnv, writeEnv, manifest.get
 *
 * Methods that exist locally but make no sense for a lite-follower
 * (admin-only, master-side): replaced with a "not on follower" error.
 *
 * Everything else is proxied via MemoryClient → RemoteClient → Iroh
 * sigil/rpc/1 to master.
 */
const LOCAL_ONLY = new Set([
  'ping',
  'mode',
  'nodeInfo',
  'readEnv',
  'writeEnv',
  'manifest.get',
]);

const FORBIDDEN_ON_LITE = new Set([
  'pair.create',
  'pair.list',
  'pair.revoke',
  'device.list',
  'device.revoke',
  'device.activate',
  'runMigrations',
  'testDbConnection',
]);

export async function installLiteProxy({ registry, log }) {
  const { getMemoryClient } = await import('../memory/client.js');

  for (const method of registry.list()) {
    if (LOCAL_ONLY.has(method)) continue;

    if (FORBIDDEN_ON_LITE.has(method)) {
      registry.replace(method, () => {
        const err = new Error(`"${method}" is not available on a lite-follower device. Run on the master device.`);
        err.code = 'not_on_follower';
        throw err;
      });
      continue;
    }

    // Proxy: lazy-load memory client, forward call to master
    registry.replace(method, async (params) => {
      const client = await getMemoryClient();
      return client.call(method, params);
    });
  }

  log(`lite-follower: ${registry.list().length} methods present, data methods proxied to master`);
}
