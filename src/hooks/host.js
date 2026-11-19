/**
 * Host adapter for Sigil's hook scripts.
 *
 * The same hook scripts serve several agents. Each agent sends a different
 * stdin payload and expects a different stdout reply, so the agent-specific
 * parts live here:
 *
 *   agent        stdin session / cwd                 context reply
 *   claude-code  session_id, cwd                     hookSpecificOutput.additionalContext
 *   codex-cli    session_id, cwd                     hookSpecificOutput.additionalContext
 *   cursor       conversation_id, workspace_roots[]  additional_context (sessionStart only)
 *
 * The agent is named on the hook command line (`sigil-hook stop --agent=cursor`),
 * which the connector writes. Entries written before that flag existed have no
 * --agent and are Claude Code's.
 *
 * Only Claude Code's Stop payload points at a transcript we can parse. Codex's
 * transcript_path is documented as unstable and Cursor's is optional, so for
 * them the prompt hook saves the user's prompt (rememberPrompt) and the Stop
 * hook reads it back (takePrompt).
 *
 * Every hook run also stamps ~/.sigil/run/seen/<agent>.hook.json. That is the proof
 * that an agent's hooks actually fire, which config files alone can't show (a
 * Codex hook that was never approved in /hooks is configured but never runs).
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { SIGIL_HOME } from '../lib/paths.js';

export const DEFAULT_AGENT = 'claude-code';
const KNOWN_AGENTS = new Set(['claude-code', 'codex-cli', 'cursor', 'kiro', 'hermes']);

const RUN_DIR = join(SIGIL_HOME, 'run');
export const SEEN_DIR = join(RUN_DIR, 'seen');
const PROMPTS_DIR = join(RUN_DIR, 'prompts');
const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

/** The agent named by `--agent=<id>` in argv, or null. */
export function agentFromArgv(argv = process.argv) {
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith('--agent='));
  const id = arg ? arg.slice('--agent='.length).trim() : '';
  return id && KNOWN_AGENTS.has(id) ? id : null;
}

/** The agent this hook process runs for. */
export function hookAgent() {
  return agentFromArgv() || process.env.SIGIL_AGENT || DEFAULT_AGENT;
}

/** Session id and working directory, whatever the agent calls them. */
export function normalizeInput(input = {}) {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  return {
    sessionId: input.session_id || input.conversation_id || null,
    cwd: input.cwd || roots[0] || null,
  };
}

/**
 * The stdout reply that adds `text` to the agent's context for `event`
 * (a Claude Code event name: SessionStart | UserPromptSubmit). An empty text
 * gives the agent's "nothing to add" reply.
 */
export function contextReply(agent, event, text) {
  if (agent === 'cursor') {
    if (event === 'UserPromptSubmit') return { continue: true };
    return text ? { additional_context: text } : {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: event,
      ...(text && { additionalContext: text }),
    },
  };
}

export const SEEN_CHANNELS = ['hook', 'mcp', 'cli'];

/**
 * Record that `agent` just reached Sigil through `channel` (hook | mcp | cli),
 * with the event that did it. One file per agent and channel, so a running MCP
 * server can't mask hooks that never fire. Best-effort, never throws.
 */
export function markSeen(agent, event, channel = 'hook') {
  try {
    mkdirSync(SEEN_DIR, { recursive: true });
    const file = join(SEEN_DIR, `${agent}.${channel}.json`);
    const at = new Date().toISOString();
    // Keep the time of each event too, so status can tell "recall runs" from
    // "saves run" (e.g. a Stop hook that never fires).
    let events = {};
    try { events = JSON.parse(readFileSync(file, 'utf8')).events || {}; } catch { /* first stamp */ }
    writeFileSync(file, JSON.stringify({ event, at, events: { ...events, [event]: at } }));
  } catch { /* best-effort */ }
}

/** When `agent` last reached Sigil, per channel: { hook?, mcp?, cli? } of { event, at }. */
export function lastSeen(agent, dir = SEEN_DIR) {
  const out = {};
  for (const channel of SEEN_CHANNELS) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, `${agent}.${channel}.json`), 'utf8'));
      if (rec && typeof rec.at === 'string') out[channel] = rec;
    } catch { /* never seen on this channel */ }
  }
  return out;
}

function promptFile(agent, sessionId) {
  const key = createHash('sha256').update(`${agent}\0${sessionId}`).digest('hex').slice(0, 24);
  return join(PROMPTS_DIR, `${key}.txt`);
}

/** Save the latest prompt of a session so the Stop hook can capture the turn. */
export function rememberPrompt(agent, sessionId, prompt) {
  if (!sessionId || typeof prompt !== 'string' || !prompt) return;
  try {
    mkdirSync(PROMPTS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(promptFile(agent, sessionId), prompt, { mode: 0o600 });
    pruneOldPrompts();
  } catch { /* best-effort */ }
}

/** Read and delete the prompt saved for a session, or null. */
export function takePrompt(agent, sessionId) {
  if (!sessionId) return null;
  const file = promptFile(agent, sessionId);
  try {
    const text = readFileSync(file, 'utf8');
    rmSync(file, { force: true });
    return text || null;
  } catch {
    return null;
  }
}

// Sessions that never reach Stop (killed agent, aborted turn) leave a prompt
// file behind. Drop anything older than a day.
function pruneOldPrompts() {
  const now = Date.now();
  for (const name of readdirSync(PROMPTS_DIR)) {
    const p = join(PROMPTS_DIR, name);
    try {
      if (now - statSync(p).mtimeMs > PROMPT_TTL_MS) rmSync(p, { force: true });
    } catch { /* raced with another hook */ }
  }
}
