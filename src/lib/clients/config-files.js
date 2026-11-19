/**
 * Shared config-file helpers for the agent connectors.
 *
 * Every write goes through safeWrite (atomic, one-time .sigil.bak, keeps the
 * file mode and symlinks). A file that exists but can't be read or parsed is
 * never replaced: starting from {} would wipe the user's other MCP servers or
 * hooks. The caller reports it instead.
 */

import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';

import { safeWrite } from '../safe-write.js';
import { MCP_SHIM_PATH } from './shim.js';

/**
 * Read a JSON config file.
 * @returns {Promise<{data: object, missing: boolean, error: string|null}>}
 *   missing → the file doesn't exist (start fresh). error → it exists but
 *   couldn't be read or parsed (don't touch it).
 */
export async function readJsonConfig(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, missing: true, error: null };
    return { data: null, missing: false, error: `could not read (${err.code || err.message})` };
  }
  if (!raw.trim()) return { data: {}, missing: false, error: null };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { data: null, missing: false, error: 'not a JSON object' };
    }
    return { data, missing: false, error: null };
  } catch (err) {
    return { data: null, missing: false, error: `invalid JSON (${err.message})` };
  }
}

/** Write a JSON config file (pretty-printed), creating its directory. */
export async function writeJsonConfig(path, data, { dryRun = false } = {}) {
  if (!dryRun) await mkdir(dirname(path), { recursive: true });
  return safeWrite(path, `${JSON.stringify(data, null, 2)}\n`, { dryRun });
}

/**
 * The MCP server entry every stdio client gets: the stable launcher, plus the
 * agent's id so its recall and saves are attributed to it rather than to a
 * generic "mcp".
 */
export function sigilMcpEntry(agent) {
  return { command: MCP_SHIM_PATH, args: [], env: { SIGIL_AGENT: agent } };
}

/**
 * Add or refresh the `sigil` entry under `key` (default `mcpServers`) in a JSON
 * MCP config, keeping every other server. Returns a plan action.
 */
export async function upsertJsonMcpServer(path, agent, { key = 'mcpServers', dryRun = false } = {}) {
  const { data, missing, error } = await readJsonConfig(path);
  if (error) return { action: 'skip', path, detail: `${error} — not touched; fix or move it, then re-run` };

  const entry = sigilMcpEntry(agent);
  const servers = data[key] && typeof data[key] === 'object' ? data[key] : {};
  if (JSON.stringify(servers.sigil) === JSON.stringify(entry)) {
    return { action: 'skip', path, detail: 'sigil MCP entry up to date' };
  }
  data[key] = { ...servers, sigil: entry };
  const result = await writeJsonConfig(path, data, { dryRun });
  return {
    action: result.action,
    path,
    detail: missing ? 'new file with sigil MCP entry' : '+sigil MCP entry (other servers preserved)',
  };
}

/** Remove the `sigil` entry from a JSON MCP config. Returns a plan action. */
export async function removeJsonMcpServer(path, { key = 'mcpServers', dryRun = false } = {}) {
  if (!existsSync(path)) return null;
  const { data, error } = await readJsonConfig(path);
  if (error) return { action: 'skip', path, detail: `${error} — not touched` };
  if (!data[key]?.sigil) return { action: 'skip', path, detail: 'sigil entry not present' };
  delete data[key].sigil;
  const result = await writeJsonConfig(path, data, { dryRun });
  return { action: result.action, path, detail: '-sigil MCP entry (other servers preserved)' };
}

/** Is a `sigil` entry present under `key`? Reports unreadable files. */
export async function hasJsonMcpServer(path, { key = 'mcpServers' } = {}) {
  if (!existsSync(path)) return { present: false, error: null };
  const { data, error } = await readJsonConfig(path);
  if (error) return { present: false, error };
  return { present: Boolean(data[key]?.sigil), error: null, entry: data[key]?.sigil || null };
}

// ── Hook files ────────────────────────────────────────────────────────────────

/** Does this hook command belong to Sigil? */
export function isSigilHookCommand(cmd) {
  return typeof cmd === 'string' && (cmd.includes('.sigil/bin/') || cmd.includes('sigil-hook'));
}

/**
 * Claude Code / Codex hook map: { Event: [{ matcher?, hooks: [{ command }] }] }.
 * Remove Sigil's groups in place, dropping events left empty. Returns true if
 * anything changed.
 */
export function stripNestedSigilHooks(hooks = {}) {
  let touched = false;
  for (const event of Object.keys(hooks)) {
    const before = hooks[event];
    if (!Array.isArray(before)) continue;
    const after = before.filter((g) => !g?.hooks?.some((h) => isSigilHookCommand(h?.command)));
    if (after.length === before.length) continue;
    touched = true;
    if (after.length) hooks[event] = after;
    else delete hooks[event];
  }
  return touched;
}

/**
 * Cursor hook map: { event: [{ command, timeout? }] }. Remove Sigil's entries
 * in place, dropping events left empty. Returns true if anything changed.
 */
export function stripFlatSigilHooks(hooks = {}) {
  let touched = false;
  for (const event of Object.keys(hooks)) {
    const before = hooks[event];
    if (!Array.isArray(before)) continue;
    const after = before.filter((h) => !isSigilHookCommand(h?.command));
    if (after.length === before.length) continue;
    touched = true;
    if (after.length) hooks[event] = after;
    else delete hooks[event];
  }
  return touched;
}
