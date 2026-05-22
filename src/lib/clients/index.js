/**
 * Client registry.
 *
 * Each module under src/lib/clients/ (except instructions.js, which is a
 * shared helper) is a "client" — an AI coding tool we can install Sigil
 * into. Adding a new client means:
 *
 *   1. Drop a new file here exporting { meta, detect, install }.
 *   2. Add one line to CLIENTS below.
 *
 * The init flow consumes `listClients()` and shows a multi-select picker;
 * detected clients are pre-checked so users on a stock setup just press
 * Enter and get sensible behavior.
 *
 * Contract for each module:
 *   - meta:     { id, label, hint }
 *   - detect(): async () => boolean      — is this client installed?
 *   - install({ dryRun }):
 *               async () => { actions: [{ action, path, detail }, ...] }
 *   - uninstall({ dryRun }):
 *               async () => { actions: [...] } — symmetric to install
 *   - verify(): async () => { installed: boolean, reason?: string }
 *               — is Sigil installed *into* this client? (used by doctor)
 */

const CLIENTS = {
  'claude-code': () => import('./claude-code.js'),
  'cursor':      () => import('./cursor.js'),
  'codex-cli':   () => import('./codex-cli.js'),
  'kiro':        () => import('./kiro.js'),
  'hermes':      () => import('./hermes.js'),
};

async function listClients() {
  const entries = await Promise.all(
    Object.entries(CLIENTS).map(async ([id, load]) => {
      const mod = await load();
      if (!mod.meta
          || typeof mod.detect !== 'function'
          || typeof mod.install !== 'function'
          || typeof mod.uninstall !== 'function'
          || typeof mod.verify !== 'function') {
        throw new Error(
          `Client "${id}" is missing the install contract — expected exports: meta, detect, install, uninstall, verify`,
        );
      }
      return {
        ...mod.meta,
        detect: mod.detect,
        install: mod.install,
        uninstall: mod.uninstall,
        verify: mod.verify,
      };
    }),
  );
  return entries;
}

export { listClients };
