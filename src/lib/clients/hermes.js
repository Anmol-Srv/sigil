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
import { existsSync } from 'node:fs';
import { PKG_ROOT } from '../paths.js';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';

const HERMES_HOME = join(homedir(), '.hermes');
const HERMES_AGENT_DIR = join(HERMES_HOME, 'hermes-agent');
const HERMES_MEMORY_PLUGINS_DIR = join(HERMES_AGENT_DIR, 'plugins', 'memory');
const HERMES_SIGIL_PLUGIN_DIR = join(HERMES_MEMORY_PLUGINS_DIR, 'sigil');
const HERMES_CONFIG_PATH = join(HERMES_HOME, 'config.yaml');

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
function setMemoryProviderInYaml(content, value) {
  const lines = content.split('\n');
  let inMemoryBlock = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top-level key (no leading whitespace, ends with `:`)
    if (/^[A-Za-z_][\w-]*:\s*$/.test(line) || /^[A-Za-z_][\w-]*:\s/.test(line)) {
      inMemoryBlock = /^memory:\s*$/.test(line);
      continue;
    }
    if (!inMemoryBlock) continue;
    // Indented `provider:` line — replace just the value.
    const m = line.match(/^(\s+provider:\s*)(['"]?)([^'"\n]*)\2(\s*(#.*)?)$/);
    if (m) {
      const [, prefix, , currentValue, trailing] = m;
      if (currentValue === value) return { content, changed: false };
      lines[i] = `${prefix}'${value}'${trailing}`;
      changed = true;
      break;
    }
  }
  return { content: lines.join('\n'), changed };
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

async function writeConfigProvider({ dryRun, value }) {
  const fs = await import('node:fs/promises');
  if (!existsSync(HERMES_CONFIG_PATH)) {
    return { action: 'skip', detail: 'config.yaml not present — set memory.provider manually' };
  }
  const before = await fs.readFile(HERMES_CONFIG_PATH, 'utf8');
  const { content: after, changed } = setMemoryProviderInYaml(before, value);
  if (!changed) {
    return { action: 'skip', detail: `memory.provider already '${value}'` };
  }
  // safeWrite drops a .sigil.bak before overwriting — the config.yaml is ~14KB
  // of the user's own settings, so a backup is non-negotiable.
  await safeWrite(HERMES_CONFIG_PATH, after, { dryRun });
  return { action: 'modify', detail: `memory.provider → '${value}'` };
}

async function install({ dryRun = false } = {}) {
  const actions = [];

  const copyResult = await copyPluginTree({ dryRun });
  actions.push({
    action: copyResult.action,
    path: HERMES_SIGIL_PLUGIN_DIR,
    detail: 'plugin tree (__init__.py, plugin.yaml, README.md)',
  });

  const cfgResult = await writeConfigProvider({ dryRun, value: 'sigil' });
  actions.push({
    action: cfgResult.action,
    path: HERMES_CONFIG_PATH,
    detail: cfgResult.detail,
  });

  return { actions };
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
      const { content: after, changed } = setMemoryProviderInYaml(before, '');
      if (changed) await safeWrite(HERMES_CONFIG_PATH, after, { dryRun });
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
