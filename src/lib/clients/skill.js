/**
 * The portable Sigil skill.
 *
 * The same compact SKILL.md is installed into Claude Code and Codex. It is
 * transport-aware rather than agent-specific: prefer registered Sigil MCP
 * tools, then fall back to the stable CLI shim. Its gstack-inspired preamble
 * is a small, read-only capability check, not a full doctor run or a hidden
 * background workflow.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

import { safeWrite } from '../safe-write.js';
import { LAUNCHER_SHIM_PATH, writeLauncherShim } from './shim.js';

const CLAUDE_SKILL_DIR = join(homedir(), '.claude', 'skills', 'sigil');
const SIGIL_SKILL_PATH = join(CLAUDE_SKILL_DIR, 'SKILL.md');
const CODEX_SKILL_DIR = join(homedir(), '.codex', 'skills', 'sigil');
const CODEX_SIGIL_SKILL_PATH = join(CODEX_SKILL_DIR, 'SKILL.md');

const SKILL_VERSION = 7;
const SKILL_MARKER = `<!-- sigil-skill:v${SKILL_VERSION} -->`;

function hasCurrentSigilSkill(content) {
  return typeof content === 'string' && content.includes(SKILL_MARKER);
}

/** Build the shared SKILL.md content. `sigilCmd` is the stable CLI fallback. */
function buildSigilSkill({ sigilCmd = LAUNCHER_SHIM_PATH } = {}) {
  return `---
name: sigil
description: Use Sigil memory deliberately across any coding agent. Apply when recalling project history, investigating a past decision, finding evidence in saved memory, saving an explicit durable decision, correcting an outdated memory, ingesting a source, or diagnosing missing/stale recall. Prefer injected recall first, then targeted Sigil search; never capture or save conversation turns automatically.
---
${SKILL_MARKER}

## Preamble (run first)

Perform this bounded, read-only preflight once per skill invocation:

1. Read an injected \`Sigil memory\` block, if one is present. That already
   searched the user’s current prompt.
2. Prefer the Sigil MCP \`status\` tool when it is available. Otherwise run:

   \`\`\`bash
   SIGIL="${sigilCmd}"
   [ -x "$SIGIL" ] && "$SIGIL" status || echo "SIGIL_STATUS: unavailable"
   \`\`\`

3. Classify the result before acting:
   - **READY**: storage is reachable. Continue with the relevant workflow.
   - **EMPTY**: storage is healthy but has no matching memory. Answer normally;
     do not invent remembered context.
   - **UNAVAILABLE**: run the explicit diagnostic path below. Do not claim
     memory is active.

Do not run \`doctor\`, an LLM, ingestion, or a write in the routine preamble.
The preamble establishes facts cheaply; it must not create hidden work.

An unavailable **optional LLM/generation provider** never proves that Sigil is
down and does not block normal recall, \`remember\`, or \`correct\`. Those
operations depend on storage plus embeddings. Report an actual tool error, not
a guessed daemon outage; only a database or embedding failure can block normal
recall/writes.

## Recall a missing fact

1. Use the injected memory first. Never repeat its exact search.
2. If the answer needs missing detail, form a narrow evidence query using the
   subject plus the distinguishing decision, time, source, or constraint.
   - Good: \`external Postgres March trade-offs\`
   - Bad: \`project context\`
3. Prefer the Sigil MCP \`search\` tool. If MCP is unavailable, run:

   \`\`\`bash
   "${sigilCmd}" search "external Postgres March trade-offs"
   \`\`\`

4. Use returned facts and provenance. If no result is relevant, say that
   Sigil has no matching memory and continue from the current conversation.

## Save, correct, or ingest deliberately

- **Save a fact** only when the user explicitly asks, or a clearly durable
  decision has just been agreed. Use MCP \`remember\`, or:

  \`\`\`bash
  "${sigilCmd}" remember "Project uses PGlite by default for local installs"
  \`\`\`

  Write short, self-contained facts. Batch related facts in one call.
- **Correct a fact** when an existing memory is known to be wrong. Search for
  it first, identify the fact id, then use MCP \`correct\`. Never add a
  conflicting duplicate as a substitute for correction.
- **Ingest a source** only when the user asks to retain a file, URL, note, or
  document for later retrieval. Ingestion is not a substitute for saving one
  simple decision.

Never infer durable memory from routine chat, run end-of-turn capture, or ask
an LLM to decide what to store.

## Recover safely

When the preflight is unavailable, use the smallest diagnostic that can explain
the failure:

\`\`\`bash
"${sigilCmd}" doctor
\`\`\`

- Missing shim or configuration: run \`sigil init\` or \`sigil connect\` as
  the diagnostic instructs.
- Database or embedding provider failure: surface the exact failed component
  and its named repair. Do not report a healthy memory system.
- Missing prompt hook: reconnect the relevant agent, then approve its hook if
  that agent requires trust review.

## Completion contract

Report one concise outcome, with evidence and the next action when needed:

- **READY**: state the relevant recalled fact or the durable write that succeeded.
- **EMPTY**: say there was no matching Sigil memory; do not imply a failure.
- **NEEDS_REPAIR**: name the failed component and one exact recovery action.

Do not paste raw diagnostics, claim a search that was not performed, or hide a
failed write. Sigil is local-first and project-aware: facts saved in a Git
repository stay focused there, while shared local memory remains a fallback.
`;
}

async function writeSkill(path, directory, { dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  if (!dryRun) await fs.mkdir(directory, { recursive: true });
  await writeLauncherShim({ dryRun });

  let existing = '';
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch { /* not written yet */ }
  if (existing.includes(SKILL_MARKER)) return { action: 'skip', path, bytes: 0 };

  const result = await safeWrite(path, buildSigilSkill(), { dryRun });
  return { action: result.action, path, bytes: result.bytes };
}

async function removeSkill(path, { dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  if (!existsSync(path)) return { action: 'skip', path, detail: 'not present' };
  if (!dryRun) await fs.rm(path, { force: true });
  return { action: dryRun ? 'plan' : 'write', path, detail: 'removed' };
}

function writeSigilSkill(options) {
  return writeSkill(SIGIL_SKILL_PATH, CLAUDE_SKILL_DIR, options);
}

function removeSigilSkill(options) {
  return removeSkill(SIGIL_SKILL_PATH, options);
}

function writeCodexSigilSkill(options) {
  return writeSkill(CODEX_SIGIL_SKILL_PATH, CODEX_SKILL_DIR, options);
}

function removeCodexSigilSkill(options) {
  return removeSkill(CODEX_SIGIL_SKILL_PATH, options);
}

export {
  SIGIL_SKILL_PATH,
  CLAUDE_SKILL_DIR,
  CODEX_SIGIL_SKILL_PATH,
  CODEX_SKILL_DIR,
  buildSigilSkill,
  hasCurrentSigilSkill,
  writeSigilSkill,
  removeSigilSkill,
  writeCodexSigilSkill,
  removeCodexSigilSkill,
};
