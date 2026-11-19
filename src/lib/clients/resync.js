/**
 * Re-sync the agents Sigil is connected to after an update.
 *
 * A release can change what Sigil writes into an agent (new hooks, a new MCP
 * field). Every update path — `sigil update`, `npm i -g @anmol-srv/sigil@latest`,
 * the curl installer — ends with the daemon restarting on the new code, so the
 * daemon does this once per version on startup. That reaches users whose
 * installed update code predates this step.
 *
 * Only agents that already have Sigil (verify: installed or partial) are
 * touched, and each connector's install() changes only Sigil's own entries.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SIGIL_HOME } from '../paths.js';

const STAMP = join(SIGIL_HOME, '.agents-synced-version');

/**
 * Re-run install() for every connected agent.
 * @returns {Promise<Array<{id: string, changed: number, error?: string}>>}
 */
export async function resyncConnectedAgents({ log = () => {}, clients } = {}) {
  const list = clients || await (await import('./index.js')).listClients();
  const results = [];
  for (const c of list) {
    try {
      const v = await c.verify();
      if (!v.installed && !v.partial) continue;
      const { actions } = await c.install({ dryRun: false });
      const changed = actions.filter((a) => a.action === 'create' || a.action === 'modify').length;
      for (const a of actions) {
        if (a.action === 'skip' && /not touched/.test(a.detail || '')) log(`agents: ${c.id}: ${a.path} — ${a.detail}`);
      }
      if (changed) log(`agents: refreshed ${c.id} (${changed} file${changed > 1 ? 's' : ''})`);
      results.push({ id: c.id, changed });
    } catch (err) {
      log(`agents: could not refresh ${c.id}: ${err.message.split('\n')[0]}`);
      results.push({ id: c.id, changed: 0, error: err.message });
    }
  }
  return results;
}

/** Run resyncConnectedAgents once per Sigil version. Never throws. */
export async function resyncOncePerVersion(version, { log = () => {}, clients, stamp = STAMP } = {}) {
  let done = null;
  try { done = readFileSync(stamp, 'utf8').trim(); } catch { /* first run */ }
  if (!version || done === version) return null;
  try {
    const results = await resyncConnectedAgents({ log, clients });
    writeFileSync(stamp, `${version}\n`);
    return results;
  } catch (err) {
    log(`agents: re-sync failed: ${err.message.split('\n')[0]}`);
    return null;
  }
}
