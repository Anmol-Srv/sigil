/**
 * Hermes Agent client integration.
 *
 * Unlike the other 4 clients (Claude Code, Cursor, Codex CLI, Kiro), Hermes
 * does NOT use MCP — it has a first-class Python memory-provider plugin
 * system. So integration means dropping a Python package into Hermes' plugin
 * tree and flipping one line in config.yaml.
 *
 * What this module does:
 *   1. Copies `<pkg>/integrations/hermes/plugin/` (which ships with Sigil)
 *      into `~/.hermes/hermes-agent/plugins/memory/sigil/`
 *   2. Sets `memory.provider: sigil` inside the `memory:` block of
 *      `~/.hermes/config.yaml` via targeted line edit — we don't round-trip
 *      the whole YAML (would lose comments + ordering across 14KB of config).
 *
 * The Python plugin itself shells out to the local `sigil` CLI at runtime,
 * so this module is purely a deployment helper. See integrations/hermes/
 * for the plugin source.
 *
 * Local-only: this module operates on the local filesystem. To install on a
 * remote Hermes host (e.g. a server), run `sigil init` there, not here.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { PKG_ROOT } from '../paths.js';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';

const HERMES_HOME = join(homedir(), '.hermes');
const HERMES_AGENT_DIR = join(HERMES_HOME, 'hermes-agent');
const HERMES_MEMORY_PLUGINS_DIR = join(HERMES_AGENT_DIR, 'plugins', 'memory');
// The BUNDLED tree. Hermes documents it as "Closed to new providers" and owns
// it, so an upgrade can overwrite anything we leave here. We install to the
// user tree below and clean this up if a previous version put a copy here.
const HERMES_BUNDLED_PLUGIN_DIR = join(HERMES_MEMORY_PLUGINS_DIR, 'sigil');
// The supported third-party location: `$HERMES_HOME/plugins/<name>/`, which is
// per-profile by design.
const HERMES_SIGIL_PLUGIN_DIR = join(HERMES_HOME, 'plugins', 'sigil');
const HERMES_CONFIG_PATH = join(HERMES_HOME, 'config.yaml');
const HERMES_PROFILES_DIR = join(HERMES_HOME, 'profiles');

const PKG_DIR = PKG_ROOT; // bundle-safe package root (see claude-code.js)
const PLUGIN_SOURCE_DIR = join(PKG_DIR, 'integrations', 'hermes', 'plugin');

const meta = {
  id: 'hermes',
  label: 'Hermes',
  hint: 'Python memory-provider plugin + config.yaml flip',
};

async function detect() {
  // Hermes uses a plugins/memory/ tree as its memory-provider discovery
  // surface. If that tree exists, Hermes is installed enough to install
  // into; we don't require the binary on PATH because Hermes manages its
  // own venv under ~/.hermes/node and ~/.hermes/bin.
  return detectInstalled({ dirs: [HERMES_MEMORY_PLUGINS_DIR, HERMES_HOME], bins: ['hermes'] });
}

// Targeted edit of the memory.provider line inside config.yaml.
//
// Why not js-yaml round-trip? The user's config.yaml is ~14KB with
// many sections + comments. js-yaml.dump() would canonicalise the file,
// drop comments, and re-order keys. A two-pass scan that only modifies
// the one line we care about preserves everything else verbatim.
//
// There ARE two `provider:` keys in Hermes config (one under `memory:`,
// one under `delegation:`) — so we lock onto the `memory:` block by
// remembering when we saw the `memory:` header and stopping at the next
// top-level key.
// Returns { content, outcome } where outcome is one of:
//   'unchanged' — a `provider:` line already holds the wanted value
//   'replaced'  — an existing `provider:` line was rewritten
//   'inserted'  — the memory: block had NO provider key, so we added one
//   'no-block'  — there is no top-level `memory:` block to edit
//
// The 'inserted' case is why this reports an outcome instead of a boolean.
// Hermes ships a `memory:` block with no `provider:` key at all, and the old
// boolean collapsed "already correct" and "nothing to edit" into the same
// false — so install cheerfully reported "memory.provider already 'sigil'"
// while writing nothing, and verify() then failed forever on a config
// `sigil init` would never repair.
function setMemoryProviderInYaml(content, value) {
  const lines = content.split('\n');
  let memoryHeader = -1;
  let blockEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTopLevel = /^[A-Za-z_][\w-]*:\s*$/.test(line) || /^[A-Za-z_][\w-]*:\s/.test(line);
    if (memoryHeader === -1) {
      if (isTopLevel && /^memory:\s*$/.test(line)) memoryHeader = i;
      continue;
    }
    // Inside the memory: block until the next top-level key.
    if (isTopLevel) { blockEnd = i; break; }
    const m = line.match(/^(\s+provider:\s*)(['"]?)([^'"\n]*)\2(\s*(#.*)?)$/);
    if (m) {
      const [, prefix, , currentValue, trailing] = m;
      if (currentValue === value) return { content, outcome: 'unchanged' };
      lines[i] = `${prefix}'${value}'${trailing}`;
      return { content: lines.join('\n'), outcome: 'replaced' };
    }
  }
  if (memoryHeader === -1) return { content, outcome: 'no-block' };

  // No provider key in the block — insert one directly under the header, using
  // the block's own indentation so the file keeps its existing style.
  if (blockEnd === -1) blockEnd = lines.length;
  const indent = lines
    .slice(memoryHeader + 1, blockEnd)
    .find((l) => /^\s+\S/.test(l))
    ?.match(/^\s+/)?.[0] ?? '  ';
  lines.splice(memoryHeader + 1, 0, `${indent}provider: '${value}'`);
  return { content: lines.join('\n'), outcome: 'inserted' };
}

async function copyPluginTree({ dryRun }) {
  const fs = await import('node:fs/promises');
  if (!existsSync(PLUGIN_SOURCE_DIR)) {
    throw new Error(
      `Plugin source missing at ${PLUGIN_SOURCE_DIR} — is this Sigil install complete? `
      + '`integrations/hermes/plugin/` must ship with the package.',
    );
  }
  if (dryRun) {
    return { action: existsSync(HERMES_SIGIL_PLUGIN_DIR) ? 'modify' : 'create' };
  }
  await fs.mkdir(dirname(HERMES_SIGIL_PLUGIN_DIR), { recursive: true });
  // Wipe the destination first so removed files (e.g. an old README) don't
  // linger after an upgrade.
  if (existsSync(HERMES_SIGIL_PLUGIN_DIR)) {
    await fs.rm(HERMES_SIGIL_PLUGIN_DIR, { recursive: true, force: true });
  }
  await fs.cp(PLUGIN_SOURCE_DIR, HERMES_SIGIL_PLUGIN_DIR, { recursive: true });
  return { action: 'create' };
}

async function writeConfigProvider({ dryRun, value, path = HERMES_CONFIG_PATH }) {
  const fs = await import('node:fs/promises');
  if (!existsSync(path)) {
    return { action: 'skip', detail: 'config.yaml not present — set memory.provider manually' };
  }
  const before = await fs.readFile(path, 'utf8');
  const { content: after, outcome } = setMemoryProviderInYaml(before, value);
  if (outcome === 'unchanged') {
    return { action: 'skip', detail: `memory.provider already '${value}'` };
  }
  if (outcome === 'no-block') {
    // Say what's actually wrong. Claiming success here is what let a broken
    // install look healthy through every re-run of `sigil init`.
    return { action: 'skip', detail: 'no top-level `memory:` block in config.yaml — add one, then re-run' };
  }
  // safeWrite drops a .sigil.bak before overwriting — the config.yaml is ~14KB
  // of the user's own settings, so a backup is non-negotiable.
  await safeWrite(path, after, { dryRun });
  return {
    action: 'modify',
    detail: outcome === 'inserted'
      ? `memory.provider: '${value}' added to the memory: block`
      : `memory.provider → '${value}'`,
  };
}

/**
 * Every config.yaml that needs the provider flipped: the top-level one plus
 * each profile's.
 *
 * Hermes runs several independent agents out of one install and EACH keeps its
 * own `~/.hermes/profiles/<name>/config.yaml`. Flipping only the top-level file
 * left every profile but the default with no memory provider at all — which is
 * exactly what had happened here: `igris` was wired up while `iron` and `xero`
 * had no `memory:` block.
 */
function configTargets() {
  const targets = [];
  if (existsSync(HERMES_CONFIG_PATH)) targets.push(HERMES_CONFIG_PATH);
  if (existsSync(HERMES_PROFILES_DIR)) {
    for (const entry of readdirSync(HERMES_PROFILES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfg = join(HERMES_PROFILES_DIR, entry.name, 'config.yaml');
      if (existsSync(cfg)) targets.push(cfg);
    }
  }
  return targets;
}

async function install({ dryRun = false } = {}) {
  const actions = [];

  const copyResult = await copyPluginTree({ dryRun });
  actions.push({
    action: copyResult.action,
    path: HERMES_SIGIL_PLUGIN_DIR,
    detail: 'plugin tree (__init__.py, plugin.yaml, README.md)',
  });

  // Retire a copy left in the bundled tree by an earlier version. Two
  // providers registered under the same name is worse than none.
  if (existsSync(HERMES_BUNDLED_PLUGIN_DIR)) {
    if (!dryRun) {
      const fs = await import('node:fs/promises');
      await fs.rm(HERMES_BUNDLED_PLUGIN_DIR, { recursive: true, force: true });
    }
    actions.push({
      action: 'delete',
      path: HERMES_BUNDLED_PLUGIN_DIR,
      detail: 'removed stale copy from Hermes\' bundled tree',
    });
  }

  for (const target of configTargets()) {
    let cfgResult = await writeConfigProvider({ dryRun, value: 'sigil', path: target });
    // A partial profile config (xero's is 3 lines) has no `memory:` block at
    // all, and does NOT inherit the top-level one — verified with
    // `hermes config get memory.provider`, which comes back empty. Our targeted
    // line edit can only replace an existing key, so hand the create case to
    // Hermes' own CLI: it owns the file format, and guessing where to splice a
    // new block into someone's config is how you corrupt it.
    if (cfgResult.action === 'skip' && /no top-level `memory:` block/.test(cfgResult.detail || '')) {
      const viaCli = await setProviderViaHermesCli({ configPath: target, dryRun });
      if (viaCli) cfgResult = viaCli;
    }
    actions.push({ action: cfgResult.action, path: target, detail: cfgResult.detail });
  }

  return { actions };
}

/**
 * Create the `memory:` block through `hermes config set`, scoped to the profile
 * that owns this config file. Returns null when the binary is unavailable, so
 * the caller keeps the honest "add one, then re-run" skip.
 */
async function setProviderViaHermesCli({ configPath, dryRun }) {
  const { dirname } = await import('node:path');
  const home = dirname(configPath);
  if (dryRun) {
    return { action: 'modify', detail: "memory.provider → 'sigil' (via hermes config set)" };
  }
  try {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync('hermes', ['config', 'set', 'memory.provider', 'sigil'], {
      env: { ...process.env, HERMES_HOME: home },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (res.status !== 0) return null;
    return { action: 'modify', detail: "memory.provider → 'sigil' (created via hermes config set)" };
  } catch {
    return null;
  }
}

async function uninstall({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const actions = [];

  if (existsSync(HERMES_SIGIL_PLUGIN_DIR)) {
    if (!dryRun) await fs.rm(HERMES_SIGIL_PLUGIN_DIR, { recursive: true, force: true });
    actions.push({ action: 'delete', path: HERMES_SIGIL_PLUGIN_DIR, detail: 'plugin directory removed' });
  } else {
    actions.push({ action: 'skip', path: HERMES_SIGIL_PLUGIN_DIR, detail: 'plugin not present' });
  }

  // Only clear the provider line if it's currently `sigil` — never overwrite
  // a user-set value pointing at another provider.
  if (existsSync(HERMES_CONFIG_PATH)) {
    const before = await fs.readFile(HERMES_CONFIG_PATH, 'utf8');
    const memoryMatch = before.match(/^memory:\s*\n([\s\S]*?)(?=^[A-Za-z_])/m);
    const memoryBlock = memoryMatch ? memoryMatch[1] : '';
    const currentProvider = memoryBlock.match(/^\s+provider:\s*['"]?([^'"\n]*)['"]?/m)?.[1];
    if (currentProvider === 'sigil') {
      const { content: after, outcome } = setMemoryProviderInYaml(before, '');
      if (outcome === 'replaced') await safeWrite(HERMES_CONFIG_PATH, after, { dryRun });
      actions.push({ action: 'modify', path: HERMES_CONFIG_PATH, detail: "memory.provider → '' (sigil cleared)" });
    } else {
      actions.push({
        action: 'skip',
        path: HERMES_CONFIG_PATH,
        detail: `memory.provider is '${currentProvider ?? ''}' (not sigil) — not touched`,
      });
    }
  }

  return { actions };
}

async function verify() {
  const fs = await import('node:fs/promises');

  if (!existsSync(HERMES_SIGIL_PLUGIN_DIR)) {
    return { installed: false, reason: 'plugin missing at ~/.hermes/hermes-agent/plugins/memory/sigil/' };
  }
  // Spot-check the plugin has its entry point — catches partial copies.
  if (!existsSync(join(HERMES_SIGIL_PLUGIN_DIR, '__init__.py'))) {
    return { installed: false, reason: 'plugin dir present but __init__.py missing' };
  }

  if (!existsSync(HERMES_CONFIG_PATH)) {
    return { installed: false, reason: '~/.hermes/config.yaml missing' };
  }
  const content = await fs.readFile(HERMES_CONFIG_PATH, 'utf8');
  const memoryMatch = content.match(/^memory:\s*\n([\s\S]*?)(?=^[A-Za-z_])/m);
  const memoryBlock = memoryMatch ? memoryMatch[1] : '';
  const currentProvider = memoryBlock.match(/^\s+provider:\s*['"]?([^'"\n]*)['"]?/m)?.[1];
  if (currentProvider !== 'sigil') {
    return {
      installed: false,
      reason: `memory.provider in config.yaml is '${currentProvider ?? ''}' (expected 'sigil')`,
    };
  }

  return { installed: true };
}

export {
  meta,
  detect,
  install,
  uninstall,
  verify,
  // Exposed for tests / advanced callers.
  setMemoryProviderInYaml,
};
