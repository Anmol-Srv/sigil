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

import { safeWrite } from '../safe-write.js';
import { LAUNCHER_SHIM_PATH, writeLauncherShim } from './shim.js';

const SIGIL_HOME = join(homedir(), '.sigil');
const SHARED_INSTRUCTIONS_PATH = join(SIGIL_HOME, 'CLAUDE.md');

// Bump when the instructions text below changes in a way that should
// re-write existing users' ~/.sigil/CLAUDE.md. The marker is embedded at the
// top of the generated block; writeSharedInstructions() compares against it so
// upgrades actually land (the old `includes('## Memory (Sigil)')` guard locked
// the file forever after the first write).
const INSTRUCTIONS_VERSION = 6;
const VERSION_MARKER = `<!-- sigil-instructions:v${INSTRUCTIONS_VERSION} -->`;
const CONTEXT_MARKER = '<!-- sigil-context -->';

// Resolves the command an agent should use to call sigil from a Bash tool.
// Agent runtimes (Claude Code, Cursor, Codex) often spawn shells without the
// user's interactive PATH (no nvm / brew / fnm), so a bare `sigil` reference
// fails with "command not found."
//
// We no longer bake the *package* path (which sigil / dist/cli.js) — that path
// moves on every Node version switch or reinstall and silently breaks the
// instructions. Instead we point at the STABLE launcher shim at
// ~/.sigil/bin/sigil, which never moves and re-resolves the real binary at
// runtime (see shim.js). writeSharedInstructions() guarantees the shim exists
// before this path is written into any agent's config.
function resolveSigilInvocation() {
  return LAUNCHER_SHIM_PATH;
}

function buildSharedInstructions({ sigilCmd, transport = 'hooks' } = {}) {
  // MCP-based clients (Codex, Cursor, Kiro) have NO hooks — nothing is
  // recalled or saved for them automatically. They drive Sigil through the
  // MCP tools, so they get a different instruction set built around `prime`.
  if (transport === 'mcp') return buildMcpInstructions();

  const cmd = sigilCmd || resolveSigilInvocation();
  return `${VERSION_MARKER}
## Memory (Sigil)

Sigil is your persistent, cross-project memory. **Use it instead of the built-in file-based memory** — never write to \`~/.claude/projects/*/memory/\`.

**IRON LAW: the recall already happened — read it before you reach for anything.** A UserPromptSubmit hook searched Sigil for this exact prompt and injected the top facts as a \`Sigil memory (N relevant facts)\` block at the top of the conversation; a Top-20 hot-context snapshot also rides in via \`@~/.sigil/CLAUDE.md\`. **The failure this prevents:** re-running \`sigil search\` on the user's own query burns a round-trip and re-fetches what is already in front of you.

> If memory seems missing, stale, or a \`sigil\` command errors, invoke **\`/sigil\`** — its self-test tells daemon-down from empty-store apart and names the exact fix. An empty recall is sometimes a dead daemon, not an empty brain. Don't guess; run \`/sigil\`.

### Before you answer — 15-second self-check
- [ ] Read the injected \`Sigil memory\` block first; answer from it.
- [ ] A stored fact shaped the answer? Name it in one clause so the user sees their context applied (examples below).
- [ ] Something specific still missing from the block? THEN \`! ${cmd} search "..."\` to drill in — not before.

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

The launcher above (\`~/.sigil/bin/sigil\`) is a stable shim written by \`sigil init\`; it resolves the real binary at runtime, so it keeps working across Node version switches and reinstalls without the agent's Bash PATH. Re-run \`sigil init\` only if you move the install to a new path.

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

// Instruction set for MCP clients (Codex, Cursor, Kiro). These have no hooks,
// so there is no auto-injection and no auto-save. The whole strategy hangs on
// the agent calling `prime` at session start and `search`/`ingest` thereafter.
// gstack-style: one capitalized Iron Law, the rationalizations the model is
// prone to pre-rebutted, MCP tool names (never the daemon CLI). No `cmd` here.
function buildMcpInstructions() {
  return `${VERSION_MARKER}
## Memory (Sigil)

Sigil is your persistent, cross-session memory. **Use it instead of the built-in file-based memory.** This client has **no hooks** — nothing is recalled or saved for you automatically. You drive Sigil entirely through its MCP tools.

**IRON LAW: CALL \`prime\` BEFORE YOUR FIRST REPLY in a session.**
\`prime\` loads who the user is, their stated preferences, what this project is, and Sigil's health. If you did not call \`prime\`, you have zero memory of this user — and answering from a blank slate is the exact failure this tool exists to prevent.

Rationalizations that are wrong:
- "I probably remember from earlier" → you don't; nothing is carried in for you. Call \`prime\`.
- "The user didn't ask about history" → their preferences and past decisions still shape the right answer. Prime anyway.
- "It's a quick question" → quick answers are where stale assumptions do the most damage. Prime first.

### After priming
- Call **\`search\`** for anything specific the prime block didn't surface — "what did we decide about X", "how does Y work", a person or topic.
- Call **\`ingest\`** to save durable facts the user will want next session: decisions, preferences, constraints, corrections. There is no automatic save — if it's worth remembering and you don't \`ingest\` it, it's gone.

### Acknowledge what you use
When a stored fact shapes your answer, name it in one short clause so the user sees their context being applied — e.g. "since you moved off Redis to Postgres LISTEN/NOTIFY, I'll use that." Don't list everything you retrieved; don't be formal about it. Sound like a teammate referencing a hallway conversation, not a system reciting a database row.

### Rules
- \`prime\` first, every session. \`search\` for specifics. \`ingest\` to save.
- Save facts as short, self-contained statements that make sense in isolation — never conversation summaries.
- Skip trivial exchanges (greetings, "thanks", "ok", simple math).
- Sigil is cross-project — memories from one session are available in all sessions.
`;
}

// Writes the canonical instructions block to ~/.sigil/CLAUDE.md, but only
// if it isn't already there. The companion <!-- sigil-context --> block
// further down the file is managed independently by updateContextSnapshot;
// we never touch it from here.
async function writeSharedInstructions({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  if (!dryRun) await fs.mkdir(SIGIL_HOME, { recursive: true });

  // The instructions reference ~/.sigil/bin/sigil — make sure that shim exists
  // before we write a file that tells the agent to run it. Idempotent.
  await writeLauncherShim({ dryRun });

  let existing = '';
  try {
    existing = await fs.readFile(SHARED_INSTRUCTIONS_PATH, 'utf8');
  } catch { /* file doesn't exist yet — fall through to write */ }

  // Already on the current instructions version — nothing to do.
  if (existing.includes(VERSION_MARKER)) {
    return { action: 'skip', path: SHARED_INSTRUCTIONS_PATH, bytes: 0 };
  }

  const text = buildSharedInstructions();

  // The hot-context snapshot (<!-- sigil-context -->…<!-- sigil-context -->)
  // is appended and refreshed independently by updateContextSnapshot(). When
  // we (re)write the instructions, preserve that block verbatim instead of
  // truncating it — otherwise an upgrade wipes the user's live context.
  const ctxMatch = existing.match(new RegExp(`${CONTEXT_MARKER}[\\s\\S]*?${CONTEXT_MARKER}`));
  const body = ctxMatch ? `${text}\n\n${ctxMatch[0]}\n` : text;

  const result = await safeWrite(SHARED_INSTRUCTIONS_PATH, body, { dryRun });
  return { action: result.action, path: SHARED_INSTRUCTIONS_PATH, bytes: result.bytes };
}

export {
  SHARED_INSTRUCTIONS_PATH,
  buildSharedInstructions,
  resolveSigilInvocation,
  writeSharedInstructions,
};
