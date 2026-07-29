/**
 * Client registry.
 *
 * Each module under src/lib/clients/ (except instructions.js, which is a
 * shared helper) is a "client" — an AI coding tool we can install Sigil
 * into. Adding a new client means:
 *
 *   1. Implement the bounded adapter operations in a module here.
 *   2. Add an allowlisted manifest in manifests.js, including its capabilities
 *      and the user-owned paths it may touch.
 *
 * The init flow consumes `listClients()` and shows a multi-select picker;
 * detected clients are pre-checked so users on a stock setup just press
 * Enter and get sensible behavior.
 *
 * Contract for each built-in module:
 *   - meta:     { id, label, hint, automaticRecall? }
 *   - detect(): async () => boolean      — is this client installed?
 *   - install({ dryRun }):
 *               async () => { actions: [{ action, path, detail }, ...] }
 *   - uninstall({ dryRun }):
 *               async () => { actions: [...] } — symmetric to install
 *   - verify(): async () => { installed: boolean, reason?: string }
 *               — is Sigil installed *into* this client? (used by doctor)
 */

import { BUILTIN_ADAPTERS } from './manifests.js';

export function createClientRegistry({ adapters = BUILTIN_ADAPTERS } = {}) {
  async function listClients() {
    const entries = await Promise.all(
      adapters.map(async ({ id, load, manifest }) => {
        const mod = await load();
        if (!mod.meta
          || mod.meta.id !== id
          || typeof mod.detect !== 'function'
          || typeof mod.install !== 'function'
          || typeof mod.uninstall !== 'function'
          || typeof mod.verify !== 'function'
          || !Number.isInteger(manifest?.version)
          || !manifest?.capabilities
          || !Array.isArray(manifest?.ownedPaths)) {
          throw new Error(
            `Client "${id}" is missing the adapter contract or manifest`,
          );
        }
        return {
          ...mod.meta,
          manifest: { id, ...manifest },
          capabilities: manifest.capabilities,
          detect: mod.detect,
          // A plan is a dry-run using the exact adapter code that will apply the
          // change. Keep install as a compatibility alias while callers migrate.
          plan: mod.plan || (() => mod.install({ dryRun: true })),
          apply: mod.apply || ((options = {}) => mod.install({ ...options, dryRun: false })),
          refresh: mod.refresh || (async () => ({ actions: [] })),
          install: mod.install,
          uninstall: mod.uninstall,
          verify: mod.verify,
        };
      }),
    );
    return entries;
  }

  return { listClients };
}

const builtInRegistry = createClientRegistry();
export const listClients = () => builtInRegistry.listClients();
