/**
 * lite-follower mode: redirect data-touching RPC methods to master.
 *
 * PR review #29: explicit allowlist of proxied methods. Previously we
 * iterated registry.list() and replaced anything not in LOCAL_ONLY —
 * which meant any future local-only method silently got proxied
 * unless the contributor remembered to add it to LOCAL_ONLY. Now we
 * proxy ONLY what's in PROXIED_TO_MASTER; anything else stays local
 * (the safer default).
 */

/** Calls that hit the canonical DB on master. */
const PROXIED_TO_MASTER = new Set([
  // Read-side
  'search',
  'searchEntity',
  'traverseGraph',
  'getFactContext',
  'getEntityContext',
  'getPod',
  'listPods',
  'listFacts',
  'status',
  'refreshContext.fetch',
  'refreshContext.explain',
  // Write-side
  'remember',
  'forgetFact',
  'ingestDoc',
]);

/** Admin-only / master-only — fail loudly on lite-follower. */
const FORBIDDEN_ON_LITE = new Set([
  'pair.create',
  'pair.list',
  'pair.revoke',
  'pair.sweep',
  'device.list',
  'device.revoke',
  'device.activate',
  'runMigrations',
  'testDbConnection',
]);

export async function installLiteProxy({ registry, log }) {
  const { getMemoryClient } = await import('../memory/client.js');

  let proxied = 0;
  let forbidden = 0;
  for (const method of PROXIED_TO_MASTER) {
    if (!registry.replace(method, async (params) => (await getMemoryClient()).call(method, params))) continue;
    proxied++;
  }
  for (const method of FORBIDDEN_ON_LITE) {
    const replaced = registry.replace(method, () => {
      const err = new Error(`"${method}" is not available on a lite-follower device. Run on the master device.`);
      err.code = 'not_on_follower';
      throw err;
    });
    if (replaced) forbidden++;
  }

  log(`lite-follower: ${proxied} methods proxied, ${forbidden} forbidden, rest local`);
}
