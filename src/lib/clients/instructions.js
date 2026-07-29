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
const INSTRUCTIONS_VERSION = 11;
const VERSION_MARKER = `<!-- sigil-instructions:v${INSTRUCTIONS_VERSION} -->`;

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

// Verification deliberately treats generated guidance as a repairable
// condition, not a broken memory connection. The hook/MCP wiring may be sound
// while an older release's instructions would teach the agent the wrong
// behavior. Keeping this check beside the writer makes `sigil update` able to
// repair exactly that drift without touching user-owned configuration.
function hasCurrentInstructions(content) {
  return typeof content === 'string' && content.includes(VERSION_MARKER);
}

function buildSharedInstructions({ sigilCmd, transport = 'hooks', automaticRecall = false } = {}) {
  // Most MCP-based clients have no hooks, so nothing is recalled or saved for
  // them automatically. Codex is the exception: it supports UserPromptSubmit
  // hooks, which let us inject one bounded recall before the agent responds.
  if (transport === 'mcp') return buildMcpInstructions({ automaticRecall });

  const cmd = sigilCmd || resolveSigilInvocation();
  return `${VERSION_MARKER}
## Memory (Sigil)

Sigil is your persistent, project-first local memory. **Use it instead of the built-in file-based memory** — never write to \`~/.claude/projects/*/memory/\`. In a Git repository, Sigil recalls that project's memories before shared local memories.

**IRON LAW: the recall already happened — read it before you reach for anything.** A UserPromptSubmit hook searched Sigil for this exact prompt and injected the top facts as a \`Sigil memory (N relevant facts)\` block at the top of the conversation. **The failure this prevents:** re-running \`sigil search\` on the user's own query burns a round-trip and re-fetches what is already in front of you.

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

### Provider boundary

An unavailable **optional LLM/generation provider** (including Claude CLI) does
not block normal Sigil recall, explicit \`remember\`, or \`correct\`. Those
operations require the database and embedding provider, not a generation model.
Never call the daemon unresponsive merely because an optional provider is down.
If a tool fails, report its exact error; use \`status\` or \`doctor\` to identify
the failed component instead of guessing.

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

### Saving — explicit and reviewable

Sigil saves memory only when you or the user explicitly request it. It does not
run an LLM after every turn or infer what should become durable memory.

You SHOULD call \`! ${cmd} remember "..."\` when:
- The user explicitly asks you to remember something ("remember that...", "save this...", "don't forget...")
- The user shares a critical fact that should be available in future sessions
- You're consolidating a multi-turn discussion into a single canonical fact

You SHOULD NOT redundantly save:
- Trivial exchanges or transient implementation detail
- Facts already stored verbatim (normalized exact duplicate suppression handles mistakes, but fewer calls are cleaner)

When you do save, batch facts into ONE truthful, synchronous call (separate quoted arguments):

\`\`\`
! ${cmd} remember "User prefers tabs over spaces" "Project uses Postgres 15"
\`\`\`

The launcher above (\`~/.sigil/bin/sigil\`) is a stable shim written by \`sigil init\`; it resolves the real binary at runtime, so it keeps working across Node version switches and reinstalls without the agent's Bash PATH. Re-run \`sigil init\` only if you move the install to a new path.

### Rules

- Read the auto-injected \`Sigil memory\` block first; answer from it before reaching for new searches
- Save facts as short, self-contained statements — never summaries of the conversation
- Each fact must make sense in isolation, without the conversation context
- Batch all explicit saves in one user-turn into a single \`${cmd} remember\` call
- Skip trivial exchanges (greetings, "thanks", "ok", simple math)
- If search and injection both return nothing, answer from your own knowledge and say so
- Sigil is project-aware: repository memories stay focused, while shared local memories remain available as a fallback
`;
}

// Instruction set for MCP clients. Most have no hooks, so there is no
// auto-injection and the strategy hangs on `prime` at session start. Codex
// opts into the stable UserPromptSubmit hook and receives a compact recall
// block before each response instead.
// gstack-style: one capitalized Iron Law, the rationalizations the model is
// prone to pre-rebutted, MCP tool names (never the daemon CLI). No `cmd` here.
function buildMcpInstructions({ automaticRecall = false } = {}) {
  if (automaticRecall) {
    return `${VERSION_MARKER}
## Memory (Sigil)

Sigil is your persistent, project-first local memory. **Use it instead of the built-in file-based memory.** In a Git repository, Sigil searches that project before shared local memory. A local UserPromptSubmit hook searches Sigil once for each user message and injects a \`Sigil memory\` block before you respond. Saving remains explicit through the Sigil MCP tools.

**IRON LAW: READ THE INJECTED MEMORY BEFORE CALLING \`search\`.** Do not repeat the same search the hook already performed. If the injected block is empty or does not answer a specific follow-up, use \`search\` to drill in.

### Use the MCP tools deliberately
- Call **\`search\`** only for a missing or narrower fact; the automatic recall is the first pass.
- Call **\`remember\`** to save durable decisions, preferences, and constraints.
- Call **\`correct\`** with a fact id when an existing memory is outdated.
- Call **\`ingest\`** only for files, URLs, or longer reference documents.

### Provider boundary
An unavailable **optional LLM/generation provider** does not block \`search\`,
\`remember\`, or \`correct\`. Do not call Sigil or its daemon unavailable based
on an optional-provider warning. If an operation fails, report the exact MCP
tool error; only a database or embedding failure can block normal recall/writes.

### Acknowledge what you use
When a stored fact shapes your answer, name it in one short clause so the user sees their context applied — e.g. "since you moved off Redis to Postgres LISTEN/NOTIFY, I'll use that." Don't list everything retrieved; don't be formal about it. Sound like a teammate referencing a hallway conversation, not a system reciting a database row.

### Rules
- Read the injected memory first; search only when it is insufficient for the question.
- Save facts as short, self-contained statements that make sense in isolation — never conversation summaries.
- Skip trivial exchanges (greetings, "thanks", "ok", simple math).
- Sigil is project-aware: repository memories stay focused, while shared local memories remain available as a fallback.
`;
  }

  return `${VERSION_MARKER}
## Memory (Sigil)

Sigil is your persistent, project-first local memory. **Use it instead of the built-in file-based memory.** In a Git repository, Sigil searches that project before shared local memory. This client has **no hooks** — nothing is recalled or saved for you automatically. You drive Sigil entirely through its MCP tools.

**IRON LAW: SEARCH ONLY WHEN THE TASK NEEDS REMEMBERED CONTEXT.** Do not run
\`prime\` or a generic search as a ritual. This client receives no injected
memory, so ask **\`search\`** a narrow question when a past decision,
preference, source, or project rule would materially change the answer.

### Targeted retrieval
- Call **\`search\`** for a concrete missing fact — "what did we decide about X", "how does Y work", a person or topic.
- Use **\`prime\`** or **\`status\`** only when checking whether Sigil itself is healthy. They do not load a generic memory snapshot.
- Call **\`remember\`** to save durable decisions, preferences, and constraints.
- Call **\`correct\`** with a fact id when an existing memory is outdated.
- Call **\`ingest\`** only for files, URLs, or longer reference documents.

### Acknowledge what you use
When a stored fact shapes your answer, name it in one short clause so the user sees their context being applied — e.g. "since you moved off Redis to Postgres LISTEN/NOTIFY, I'll use that." Don't list everything you retrieved; don't be formal about it. Sound like a teammate referencing a hallway conversation, not a system reciting a database row.

### Rules
- \`search\` for specific missing context. \`remember\` to save durable facts.
- Save facts as short, self-contained statements that make sense in isolation — never conversation summaries.
- Skip trivial exchanges (greetings, "thanks", "ok", simple math).
- Sigil is project-aware: repository memories stay focused, while shared local memories remain available as a fallback.
`;
}

// Writes the canonical instructions block to ~/.sigil/CLAUDE.md.
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

  const result = await safeWrite(SHARED_INSTRUCTIONS_PATH, text, { dryRun });
  return { action: result.action, path: SHARED_INSTRUCTIONS_PATH, bytes: result.bytes };
}

export {
  SHARED_INSTRUCTIONS_PATH,
  buildSharedInstructions,
  hasCurrentInstructions,
  resolveSigilInvocation,
  writeSharedInstructions,
};
