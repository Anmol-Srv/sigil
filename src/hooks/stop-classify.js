/**
 * Shared classify + save logic for the Stop hook and the spool replayer.
 *
 * Extracted from stop.js so `drainStopSpool` (which runs in the daemon at boot
 * and from `sigil doctor`) replays a spooled message through the EXACT same
 * path the live hook uses — no logic drift between first-attempt and replay.
 * stop.js calls `main()` at module load, so it can't be imported; this module
 * has no side effects on import.
 */
import { maskSecrets } from './secret-mask.js';

const CLASSIFIER_PROMPT = `You decide whether a user's message contains durable, memorable content for a long-term AI memory system, and extract the facts if so.

SAVE these signals:
- Preferences ("I prefer X", "I always X", "I never X", "I like X")
- Decisions ("we use X", "we picked X", "we don't use X", "we moved off X")
- Constraints ("we can't use X because…", "X is blocked", "X must support Y")
- Corrections ("actually it's X, not Y", "we changed X to Y")
- Factual claims about the user's project, codebase, team, tools, or conventions

DO NOT save:
- Questions or code requests ("write me a X", "how do I Y", "fix this")
- Casual chitchat or greetings ("ok", "thanks", "hi")
- Ephemeral context that won't generalize ("this file", "this branch", "this run")
- Generic claims about the world ("Python is interpreted", "git is version control")
- Commands or instructions to Claude itself ("be more careful", "don't apologize")

Each saved fact must:
- Be a complete declarative statement that makes sense without the surrounding conversation
- Stay under 25 words
- Be specific enough that retrieving it later helps Claude answer better
- Be phrased in third person where natural ("User prefers X" or "Project uses X")

Respond as STRICT JSON, no markdown:
{"memorable": boolean, "facts": ["...", "..."]}

If "memorable" is false, "facts" must be an empty array.`;

/**
 * Classify a user message into zero or more memorable facts. Throws if the LLM
 * call itself fails (caller decides whether to spool); returns [] when the
 * message is judged not memorable.
 */
async function classifyTurn(userMessage) {
  const { promptJson } = await import('../lib/llm.js');
  const config = (await import('../config.js')).default;

  const input = `${CLASSIFIER_PROMPT}\n\n---\nUser message:\n${userMessage}`;

  const result = await promptJson(input, {
    model: config.llm.extractionModel,
    caller: 'stop-hook',
  });

  if (!result || result.memorable !== true) return [];
  if (!Array.isArray(result.facts)) return [];

  return result.facts
    .filter((f) => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length >= 8 && f.length <= 200);
}

/**
 * Save classified facts through the regular AUDM ingest pipeline.
 *
 * `throwOnError` lets the spool replayer surface a save failure (so the entry
 * stays spooled for the next attempt); the live hook keeps the legacy
 * best-effort behaviour (log + continue) so it never blocks Claude.
 */
async function saveFacts(facts, { podUids = [], throwOnError = false, cwd = null } = {}) {
  const { ingestDocument } = await import('../ingestion/pipeline.js');
  const { resolveNamespace } = await import('../memory/namespace.js');

  // Per-project namespace: the Stop hook carries the turn's cwd, so a committed
  // `.sigil/namespace` marker (or SIGIL_NAMESPACE env) routes auto-saved facts
  // to the team namespace. With neither set this is the install default —
  // identical to the prior behavior.
  const namespace = resolveNamespace({ cwd });

  for (const fact of facts) {
    try {
      await ingestDocument({
        content: fact,
        namespace,
        // Skip the LLM classifier inside the pipeline — we already classified.
        // The fact-extraction step still runs.
        classify: false,
        podUids,
      });
    } catch (err) {
      process.stderr.write(`[sigil:stop] save failed: ${maskSecrets(err.message)}\n`);
      if (throwOnError) throw err;
    }
  }

  // Refresh hot-context so the new fact shows up at next session start
  try {
    const { updateContextSnapshot } = await import('../memory/facts/hot-context.js');
    await updateContextSnapshot({ namespace });
  } catch { /* best effort */ }
}

export { classifyTurn, saveFacts, CLASSIFIER_PROMPT };
