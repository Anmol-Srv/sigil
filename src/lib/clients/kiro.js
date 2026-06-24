/**
 * Kiro client integration.
 *
 * Kiro (AWS) exposes two relevant surfaces:
 *   1. ~/.kiro/settings/mcp.json    — MCP server registration. Same JSON
 *                                      shape as Claude Desktop / Cursor.
 *   2. ~/.kiro/steering/sigil.md    — global "steering" rule. Kiro picks
 *                                      up steering files automatically; no
 *                                      frontmatter / opt-in flag needed.
 *
 * Note on Kiro's "agent hooks": those are event-driven actions (file-save
 * triggers, manual triggers) configured in Kiro's UI — they are not a
 * pre-prompt injection mechanism like Claude Code's UserPromptSubmit.
 * We deliberately do NOT try to register Sigil as a Kiro hook; the right
 * surface for read-before-answer is the steering file plus the MCP server.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { PKG_ROOT } from '../paths.js';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { buildSharedInstructions } from './instructions.js';
import { MCP_SHIM_PATH, writeLauncherShim, resolveServerPath } from './shim.js';

const KIRO_HOME = join(homedir(), '.kiro');
const KIRO_MCP_PATH = join(KIRO_HOME, 'settings', 'mcp.json');
const KIRO_STEERING_PATH = join(KIRO_HOME, 'steering', 'sigil.md');

const PKG_DIR = PKG_ROOT; // bundle-safe package root (see claude-code.js)

const meta = {
  id: 'kiro',
  label: 'Kiro',
  hint: 'MCP + steering file (steering auto-applies)',
};

async function detect() {
  return detectInstalled({ dirs: [KIRO_HOME], apps: ['Kiro'], bins: ['kiro'] });
}


// Merge the sigil entry into ~/.kiro/settings/mcp.json. Same JSON shape +
// merge logic as Cursor; preserves any other MCP servers the user has.
async function writeMcpEntry({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  let config = {};
  try {
    const raw = await fs.readFile(KIRO_MCP_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch { /* file doesn't exist or invalid — start fresh */ }

  const existedBefore = existsSync(KIRO_MCP_PATH);
  config.mcpServers = config.mcpServers || {};
  // Point `command` at the stable MCP shim (~/.sigil/bin/sigil-mcp), not a
  // baked `node /abs/dist/server.js` — survives Node-version switches /
  // reinstalls. config.json remains the source of truth for runtime config.
  await writeLauncherShim({ dryRun });
  config.mcpServers.sigil = {
    command: MCP_SHIM_PATH,
    args: [],
  };

  if (!dryRun) await fs.mkdir(dirname(KIRO_MCP_PATH), { recursive: true });
  const result = await safeWrite(KIRO_MCP_PATH, JSON.stringify(config, null, 2), { dryRun });
  return {
    action: result.action,
    path: KIRO_MCP_PATH,
    detail: existedBefore
      ? '+sigil MCP server (other entries preserved)'
      : 'new mcp.json with sigil entry',
  };
}

// Kiro reads all *.md files under ~/.kiro/steering/ as always-on context.
// No frontmatter needed — placement is the opt-in. Each tool that writes
// here owns one file, so overwriting sigil.md cleanly is safe.
async function writeSteeringFile({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  if (!dryRun) await fs.mkdir(dirname(KIRO_STEERING_PATH), { recursive: true });
  const result = await safeWrite(KIRO_STEERING_PATH, buildSharedInstructions({ transport: 'mcp' }), { dryRun });
  return {
    action: result.action,
    path: KIRO_STEERING_PATH,
    detail: `${result.bytes ?? 0} bytes, steering (always-on)`,
  };
}

async function install({ dryRun = false } = {}) {
  const actions = [];

  const mcp = await writeMcpEntry({ dryRun });
  if (mcp) actions.push(mcp);

  const steering = await writeSteeringFile({ dryRun });
  if (steering) actions.push(steering);

  return { actions };
}

async function verify({ deep = false } = {}) {
  const fs = await import('node:fs/promises');

  if (!existsSync(KIRO_MCP_PATH)) {
    return { installed: false, reason: '~/.kiro/settings/mcp.json missing' };
  }
  let config;
  try {
    config = JSON.parse(await fs.readFile(KIRO_MCP_PATH, 'utf8'));
  } catch {
    return { installed: false, reason: '~/.kiro/settings/mcp.json is not valid JSON' };
  }
  if (!config.mcpServers?.sigil) {
    return { installed: false, reason: 'sigil entry missing from ~/.kiro/settings/mcp.json' };
  }

  if (!existsSync(KIRO_STEERING_PATH)) {
    return { installed: false, reason: '~/.kiro/steering/sigil.md missing' };
  }

  if (!existsSync(MCP_SHIM_PATH)) {
    return { installed: false, reason: `MCP launcher missing at ${MCP_SHIM_PATH} — run \`sigil connect\`` };
  }
  const serverPath = resolveServerPath();
  if (!existsSync(serverPath)) {
    return { installed: false, reason: `MCP server missing at ${serverPath} — run \`sigil connect\` to refresh` };
  }
  if (deep) {
    const { verifyMcpRoundTrip } = await import('./roundtrip.js');
    const rt = await verifyMcpRoundTrip(serverPath);
    if (!rt.ok) return { installed: false, reason: `MCP round-trip failed: ${rt.reason}` };
  }

  return { installed: true };
}

async function uninstall({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const actions = [];

  if (existsSync(KIRO_MCP_PATH)) {
    let config;
    try {
      config = JSON.parse(await fs.readFile(KIRO_MCP_PATH, 'utf8'));
    } catch {
      actions.push({ action: 'skip', path: KIRO_MCP_PATH, detail: 'invalid JSON — not touched' });
      return { actions };
    }
    if (config.mcpServers?.sigil) {
      delete config.mcpServers.sigil;
      const result = await safeWrite(KIRO_MCP_PATH, JSON.stringify(config, null, 2), { dryRun });
      actions.push({ action: result.action, path: KIRO_MCP_PATH, detail: '-sigil MCP entry' });
    } else {
      actions.push({ action: 'skip', path: KIRO_MCP_PATH, detail: 'sigil entry not present' });
    }
  }

  if (existsSync(KIRO_STEERING_PATH)) {
    if (!dryRun) await fs.unlink(KIRO_STEERING_PATH);
    actions.push({ action: 'delete', path: KIRO_STEERING_PATH, detail: 'sigil steering file removed' });
  }

  return { actions };
}

export {
  meta,
  detect,
  install,
  uninstall,
  verify,
  writeMcpEntry,
  writeSteeringFile,
  resolveServerPath,
};
