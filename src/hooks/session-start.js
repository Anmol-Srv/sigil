#!/usr/bin/env node

/**
 * Session-start hook for agents other than Claude Code (Codex CLI, Cursor).
 *
 * Runs the same engine as `sigil preamble` and the `prime` MCP tool: Sigil's
 * health lines plus fresh project-scoped memory, added to the new session's
 * context in the agent's reply format (see host.js). Claude Code keeps its
 * own entry (`sigil preamble --format=lines`), whose per-prompt hook does the
 * recall.
 *
 * Budget: bounded by DEADLINE_MS. A slow or absent daemon means nothing is
 * added, never a stuck session start. Exit code is always 0.
 */

import { maskSecrets } from './secret-mask.js';
import { loadHookEnv } from './env-loader.js';
import { readStdin } from './io.js';
import { hookAgent, normalizeInput, contextReply, markSeen } from './host.js';

loadHookEnv();
const AGENT = hookAgent();

// Codex and Cursor give hooks far more than this; stay well under the timeout
// the connectors set (15s) so a cold daemon start can't hang the session.
const DEADLINE_MS = 9_000;
const FACT_LIMIT = 12;

function respond(text) {
  process.stdout.write(JSON.stringify(contextReply(AGENT, 'SessionStart', text)), () => process.exit(0));
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { /* use defaults */ }
  markSeen(AGENT, 'session-start');

  // Codex runs hooks in the session's directory. Cursor runs user hooks from
  // ~/.cursor, so without workspace_roots there is no project to scope to:
  // pass none rather than ~/.cursor.
  const { cwd } = normalizeInput(input);
  const scope = cwd || (AGENT === 'cursor' ? null : process.cwd());
  const { buildPreamble } = await import('../preamble/run.js');
  const { renderPreamble } = await import('../preamble/render.js');

  let timer;
  const deadline = new Promise((res) => { timer = setTimeout(() => res(null), DEADLINE_MS); timer.unref?.(); });
  const result = await Promise.race([buildPreamble({ cwd: scope, limit: FACT_LIMIT }), deadline]);
  clearTimeout(timer);
  if (!result) {
    process.stderr.write('[sigil:session-start] preamble exceeded budget — nothing added\n');
    return respond();
  }

  const transport = AGENT === 'cursor' ? 'session-hooks' : 'hooks';
  return respond(maskSecrets(renderPreamble(result, { format: 'md', transport })));
}

main().catch((err) => {
  try { process.stderr.write(`[sigil:session-start] fatal: ${maskSecrets(err?.message || String(err))}\n`); } catch { /* */ }
  respond();
});
