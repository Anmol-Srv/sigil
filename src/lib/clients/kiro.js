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

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { upsertJsonMcpServer, removeJsonMcpServer, hasJsonMcpServer } from './config-files.js';
import { buildSharedInstructions } from './instructions.js';
import { MCP_SHIM_PATH, writeLauncherShim, resolveServerPath } from './shim.js';

const KIRO_HOME = join(homedir(), '.kiro');
const KIRO_MCP_PATH = join(KIRO_HOME, 'settings', 'mcp.json');
const KIRO_STEERING_PATH = join(KIRO_HOME, 'steering', 'sigil.md');

const meta = {
  id: 'kiro',
  label: 'Kiro',
  hint: 'MCP tools + steering file',
  capabilities: { sessionStart: 'none', recall: 'tool', capture: 'tool', tools: 'mcp' },
  firstRunHint: 'Open Kiro and start a chat',
  requiresRestart: true,
};

async function detect() {
  return detectInstalled({ dirs: [KIRO_HOME], apps: ['Kiro'], bins: ['kiro'] });
}


// Merge the sigil entry into ~/.kiro/settings/mcp.json (same JSON shape as
// Cursor), keeping the user's other servers. An unreadable file is left alone.
async function writeMcpEntry({ dryRun = false } = {}) {
  await writeLauncherShim({ dryRun });
  return upsertJsonMcpServer(KIRO_MCP_PATH, 'kiro', { dryRun });
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
  const mcp = await hasJsonMcpServer(KIRO_MCP_PATH);
  if (mcp.error) return { installed: false, partial: false, reason: `~/.kiro/settings/mcp.json ${mcp.error}` };
  const steering = existsSync(KIRO_STEERING_PATH);
  const missing = [];
  if (!mcp.present) missing.push('MCP entry in ~/.kiro/settings/mcp.json');
  if (!steering) missing.push('steering file ~/.kiro/steering/sigil.md');
  if (missing.length) return { installed: false, partial: mcp.present || steering, reason: `missing: ${missing.join('; ')}` };

  if (!existsSync(MCP_SHIM_PATH)) {
    return { installed: false, partial: true, reason: `MCP launcher missing at ${MCP_SHIM_PATH} — run \`sigil connect\`` };
  }
  const serverPath = resolveServerPath();
  if (!existsSync(serverPath)) {
    return { installed: false, partial: true, reason: `MCP server missing at ${serverPath} — run \`sigil connect\`` };
  }
  if (deep) {
    const { verifyMcpRoundTrip } = await import('./roundtrip.js');
    const rt = await verifyMcpRoundTrip(serverPath);
    if (!rt.ok) return { installed: false, partial: true, reason: `MCP round-trip failed: ${rt.reason}` };
  }

  return { installed: true };
}

async function uninstall({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const actions = [];

  const mcp = await removeJsonMcpServer(KIRO_MCP_PATH, { dryRun });
  if (mcp) actions.push(mcp);

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
