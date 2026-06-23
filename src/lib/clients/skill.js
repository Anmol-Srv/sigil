/**
 * The `/sigil` Claude Code skill.
 *
 * Modeled on how gstack ships capabilities: a skill directory under
 * ~/.claude/skills/<name>/SKILL.md whose `## Preamble (run first)` block the
 * model executes first — it self-tests the live connection (daemon, DB, hooks,
 * shim) and echoes status lines the model reads and acts on, then guides the
 * user through any fix.
 *
 * Sigil's hooks make memory automatic, but nothing ever VERIFIED that memory is
 * actually live, and there was no entry point to diagnose "is Sigil working?".
 * This skill is that entry point. `sigil init` writes it (see claude-code.js);
 * it is idempotent and version-marked like the shared instructions.
 *
 * The content references the STABLE launcher shim (~/.sigil/bin/sigil), never a
 * package path that moves on a Node switch / reinstall — same rationale as
 * instructions.js.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

import { safeWrite } from '../safe-write.js';
import { LAUNCHER_SHIM_PATH, writeLauncherShim } from './shim.js';

const CLAUDE_SKILL_DIR = join(homedir(), '.claude', 'skills', 'sigil');
const SIGIL_SKILL_PATH = join(CLAUDE_SKILL_DIR, 'SKILL.md');

// Bump when the skill text changes in a way existing installs should pick up.
// The marker sits right under the frontmatter; writeSigilSkill() compares
// against it so re-running init actually re-writes an out-of-date skill.
const SKILL_VERSION = 2;
const SKILL_MARKER = `<!-- sigil-skill:v${SKILL_VERSION} -->`;

/** Build the SKILL.md content. `sigilCmd` is the shim path the preamble calls. */
function buildSigilSkill({ sigilCmd = LAUNCHER_SHIM_PATH } = {}) {
  return `---
name: sigil
description: Verify the Sigil persistent-memory connection is live and guide setup/usage. Use when memory recall seems missing or stale, a \`sigil\` command errored, or to confirm auto-recall/save is working before relying on it.
version: ${SKILL_VERSION}.0.0
triggers:
  - is sigil working
  - check memory
  - sigil not working
  - is memory working
  - sigil status
  - memory connection
allowed-tools:
  - Bash
  - Read
---
${SKILL_MARKER}

## When to invoke this skill

Run \`/sigil\` when:
- Memory recall seems missing or stale (no \`Sigil memory\` block where you'd expect one).
- A \`sigil\` command errored, or the user asks "is memory working?".
- You're about to rely on stored context in a new repo and want to confirm Sigil is live first.

## Preamble (run first)

Run this self-test and read the status lines it prints. It never changes state —
it only probes the connection.

\`\`\`bash
SIGIL="${sigilCmd}"
# 1. Shim present? (the stable launcher written by \`sigil init\`)
if [ -x "$SIGIL" ]; then echo "SHIM: ok ($SIGIL)"; else echo "SHIM: MISSING — run: sigil init"; fi
# 2. Daemon reachable? (ping auto-starts it if installed, so this also warms it)
if [ -x "$SIGIL" ] && "$SIGIL" ping >/dev/null 2>&1; then echo "DAEMON: up"; else echo "DAEMON: down"; fi
# 3. Deep health — daemon, DB reachability/schema, providers, hook wiring
echo "--- sigil doctor ---"
[ -x "$SIGIL" ] && "$SIGIL" doctor 2>&1 | tail -n 30 || echo "doctor: unavailable"
# 4. Knowledge-base stats — proves the DB is queryable and how much is stored
echo "--- sigil status ---"
[ -x "$SIGIL" ] && "$SIGIL" status 2>&1 | tail -n 15 || echo "status: unavailable"
\`\`\`

## Read the result, then guide the user

Map what the preamble printed to one action:

- **SHIM: MISSING** → Sigil isn't installed into this account. Tell the user to run
  \`sigil init\` (one time), then re-run \`/sigil\`.
- **DAEMON: down** and doctor can't reach it → start it: \`! ${sigilCmd} start\`
  (most \`sigil\` commands auto-spawn it, so this is rarely needed). Re-check with
  \`! ${sigilCmd} ping\`.
- **doctor reports DB unreachable / schema missing** → memory can't store or
  recall. Surface the exact line doctor printed and the remedy it names
  (commonly \`sigil migrate\`, or starting the local Postgres/Docker). Don't claim
  memory works until doctor is green.
- **doctor flags missing/stale hooks** → the auto-recall + auto-save wiring drifted
  (e.g. settings.json was hand-edited). Re-run \`sigil init\` to repair it.
- **doctor flags an LLM/embedding provider DOWN** → extraction + search will fail
  even with a healthy DB. Point the user at the provider line (revoked key,
  unreachable Ollama, wrong model).
- **All green** → memory is live. Proceed normally and use it (below).

### Before you report — self-check
- [ ] Mapped every non-green line to a fix above (never report "healthy" while doctor shows a DOWN line).
- [ ] Reporting the ONE-LINE verdict + the single next action — not pasting raw \`doctor\`/\`status\` output.
- [ ] If down: named the specific cause AND the exact command, so the user can act without re-reading.

State the verdict in one line, then stop. **The failure this prevents:** dumping 30 lines of
\`doctor\` output and making the user diagnose it themselves.

- GOOD: "Sigil is live — 214 facts, DB healthy, all 4 hooks wired. Auto-recall is on."
- GOOD: "Sigil is down: daemon up but DB unreachable (Postgres refused on :5432). Fix: start Postgres, then \`sigil migrate\`."
- BAD: "Here's the doctor output: [30 lines]. Looks like there might be some issues."

## Using Sigil once it's verified

The full reflexes live in the imported \`~/.sigil/CLAUDE.md\`. In short:

- **Recall is automatic.** A UserPromptSubmit hook searches memory on every message
  and injects a \`Sigil memory\` block. Read it first; only run
  \`! ${sigilCmd} search "..."\` to drill into something the injection missed.
- **Saving is automatic.** A Stop hook captures memorable facts each turn. Call
  \`! ${sigilCmd} remember --bg "fact one" "fact two"\` ONLY when the user explicitly
  asks to remember something, or a critical fact must be available within this same
  session. Batch facts into one call.
- Save short, self-contained statements — never conversation summaries. Sigil is
  cross-project: memories from one session are available everywhere.
`;
}

/**
 * Write ~/.claude/skills/sigil/SKILL.md. Idempotent: skips when the current
 * version marker is already present. Ensures the launcher shim exists first
 * (the skill tells the agent to run it).
 */
async function writeSigilSkill({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  if (!dryRun) await fs.mkdir(CLAUDE_SKILL_DIR, { recursive: true });
  await writeLauncherShim({ dryRun });

  let existing = '';
  try {
    existing = await fs.readFile(SIGIL_SKILL_PATH, 'utf8');
  } catch { /* not written yet */ }

  if (existing.includes(SKILL_MARKER)) {
    return { action: 'skip', path: SIGIL_SKILL_PATH, bytes: 0 };
  }

  const result = await safeWrite(SIGIL_SKILL_PATH, buildSigilSkill(), { dryRun });
  return { action: result.action, path: SIGIL_SKILL_PATH, bytes: result.bytes };
}

/** Remove the skill (uninstall). Best-effort; leaves the skills/ dir in place. */
async function removeSigilSkill({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  if (!existsSync(SIGIL_SKILL_PATH)) {
    return { action: 'skip', path: SIGIL_SKILL_PATH, detail: 'not present' };
  }
  if (!dryRun) await fs.rm(SIGIL_SKILL_PATH, { force: true });
  return { action: dryRun ? 'plan' : 'write', path: SIGIL_SKILL_PATH, detail: 'removed' };
}

export {
  SIGIL_SKILL_PATH,
  CLAUDE_SKILL_DIR,
  buildSigilSkill,
  writeSigilSkill,
  removeSigilSkill,
};
