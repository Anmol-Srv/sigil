/**
 * Shared instructions text for AI agent clients.
 *
 * Sigil writes a single canonical instructions file at ~/.sigil/CLAUDE.md
 * (legacy name; despite the suffix it is client-agnostic). Each client
 * module references this file in its own way:
 *   - Claude Code: @import line in ~/.claude/CLAUDE.md
 *   - Cursor:      copied into .cursor/rules/sigil.mdc (with frontmatter)
 *   - Codex CLI:   referenced from AGENTS.md
 *   - Kiro:        copied into .kiro/steering/sigil.md
 *
 * Keeping the content here means the rules — "search before answering",
 * "save in batches", the SHOULD/SHOULD NOT lists — live in exactly one
 * place and stay consistent across clients.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { safeWrite } from '../safe-write.js';

const SIGIL_HOME = join(homedir(), '.sigil');
const SHARED_INSTRUCTIONS_PATH = join(SIGIL_HOME, 'CLAUDE.md');

// Resolves the command an agent should use to call sigil from a Bash tool.
// Agent runtimes (Claude Code, Cursor, Codex) often spawn shells without the
// user's interactive PATH (no nvm / brew / fnm), so a bare `sigil` reference
// fails with "command not found." Bake the absolute install path into the
// instructions at write time so every call from the model lands a real binary.
//
// Detection order:
//   1. `which sigil` — finds the installed bin symlink (preferred — uses
//      the user's regular shell PATH at the moment init runs).
//   2. `process.argv[1]` — the path to the running CLI script. Always
//      absolute, executable via shebang.
function resolveSigilInvocation() {
  try {
    const path = execSync('which sigil', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString().trim();
    if (path) return path;
  } catch { /* not on PATH from this shell — fall through */ }
  return process.argv[1];
}

function buildSharedInstructions({ sigilCmd } = {}) {
  const cmd = sigilCmd || resolveSigilInvocation();
  return `## Memory (Sigil)

Sigil is your persistent memory system. **Use it instead of the built-in file-based memory.**
Do NOT write to \`~/.claude/projects/*/memory/\` or any local memory files — use Sigil exclusively.

### Memory is auto-injected — don't re-search by default

Two hooks do the work for you before you ever see a prompt:

- **UserPromptSubmit hook**: runs hybrid search against Sigil on every user message and injects the top-K relevant facts into your context as \`additionalContext\` at the top of the conversation. The injected block is labelled \`Sigil memory (N relevant facts)\` — when you see that block, those facts are already loaded; you do NOT need to call \`sigil search\` to retrieve them.
- **Top-20 hot-context**: a snapshot of the user's most-important / most-recently-accessed facts is always loaded into the session via \`@~/.sigil/CLAUDE.md\` in the Claude config. Treat it as always-available background context.

**The right reflex:** read the injected \`Sigil memory\` block first, answer from it, then call \`sigil search\` ONLY if the injection clearly missed something specific.

Concretely, you SHOULD call \`! ${cmd} search "..."\` when:
- The user asks a drill-down question and you need facts the auto-injection didn't surface ("tell me more about the postmortem")
- You're answering a *follow-up* in a long session where the relevant facts were never in the original injection
- You suspect a stale answer and want to verify against the latest stored state

You SHOULD NOT call \`sigil search\` when:
- The injected \`Sigil memory\` block already lists facts that directly answer the user's question — just use them
- You'd be searching for the same query Sigil already auto-searched (the user's literal prompt)
- The question is general-knowledge and doesn't need this user's specific context

In short: **the hook already searched. Trust it. Drill down only when needed.**

### Acknowledge what you know

When your response is shaped by a fact pulled from Sigil — a stored preference, decision, constraint, or piece of project history — **briefly call it out in plain language so the user sees their context being applied.** One short clause is enough; don't lecture.

Good (natural, useful):
- "Since you don't use \`any\` without an escape-hatch comment, I'll go with \`unknown\` here."
- "Per your ADR-001 I've wrapped the response in \`{ok, data, error}\`."
- "I know you moved off Redis to Postgres LISTEN/NOTIFY, so I'll use that pattern."
- "Going with named exports since you prefer those."

Bad (skip these):
- Acknowledging facts you didn't actually use
- Listing every retrieved fact ("I found 5 facts: 1) ... 2) ...")
- Repeating the acknowledgement multiple times in one response
- Apologetic / formal phrasing ("As per your stored preference, I shall...")

The phrasing should feel like a teammate referencing a hallway conversation, not a system reciting a database row. If a fact didn't materially shape the answer, don't mention it.

### Saving — Stop hook handles routine; you only save when explicit

A Stop hook fires after every assistant turn, scans the user's latest message with a classifier, and saves anything memorable (preferences, decisions, constraints, corrections, factual claims) on its own. **You do not need to call \`sigil remember\` to make this work.**

You SHOULD call \`! ${cmd} remember --bg "..."\` ONLY when:
- The user explicitly asks you to remember something ("remember that...", "save this...", "don't forget...") — save immediately, don't wait for the Stop hook
- The user shares a critical fact mid-response that's important enough to be available within this same session for follow-ups (the Stop hook only runs at turn end)
- You're consolidating a multi-turn discussion into a single canonical fact

You SHOULD NOT redundantly save:
- Generic preferences the Stop hook will obviously catch — let it
- Facts already similar to existing memory (AUDM dedup handles this, but the cleaner UX is fewer Bash invocations on screen)

When you do save, batch facts into ONE call (separate quoted arguments), use \`--bg\` to return immediately:

\`\`\`
! ${cmd} remember --bg "User prefers tabs over spaces" "Project uses Postgres 15"
\`\`\`

The absolute path above is baked in by \`sigil init\` so the command works regardless of which shell PATH the agent's Bash subprocess inherits. Re-run \`sigil init\` to refresh after moving machines or reinstalling.

### Rules

- Read the auto-injected \`Sigil memory\` block first; answer from it before reaching for new searches
- Save facts as short, self-contained statements — never summaries of the conversation
- Each fact must make sense in isolation, without the conversation context
- Batch all explicit saves in one user-turn into a single \`${cmd} remember --bg\` call
- Skip trivial exchanges (greetings, "thanks", "ok", simple math)
- If search and injection both return nothing, answer from your own knowledge and say so
- Sigil is cross-project — memories from one session are available in all sessions
`;
}

// Writes the canonical instructions block to ~/.sigil/CLAUDE.md, but only
// if it isn't already there. The companion <!-- sigil-context --> block
// further down the file is managed independently by updateContextSnapshot;
// we never touch it from here.
async function writeSharedInstructions({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  if (!dryRun) await fs.mkdir(SIGIL_HOME, { recursive: true });

  try {
    const existing = await fs.readFile(SHARED_INSTRUCTIONS_PATH, 'utf8');
    if (existing.includes('## Memory (Sigil)')) {
      return { action: 'skip', path: SHARED_INSTRUCTIONS_PATH, bytes: 0 };
    }
  } catch { /* file doesn't exist yet — fall through to write */ }

  const text = buildSharedInstructions();
  const result = await safeWrite(SHARED_INSTRUCTIONS_PATH, text, { dryRun });
  return { action: result.action, path: SHARED_INSTRUCTIONS_PATH, bytes: result.bytes };
}

export {
  SHARED_INSTRUCTIONS_PATH,
  buildSharedInstructions,
  resolveSigilInvocation,
  writeSharedInstructions,
};
