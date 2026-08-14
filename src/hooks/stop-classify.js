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

/** Classify a replay batch in one provider call instead of one cold call/turn. */
async function classifyTurns(userMessages, { caller = 'stop-spool' } = {}) {
  if (!userMessages.length) return [];
  const { promptJson } = await import('../lib/llm.js');
  const config = (await import('../config.js')).default;
  const turns = userMessages.map((message, index) => ({ index, message }));
  const input = `${CLASSIFIER_PROMPT}\n\nClassify every independent turn below. Return {"turns":[{"index":0,"memorable":true,"facts":["..."]}]}, one entry per input.\n\n${JSON.stringify(turns)}`;
  const result = await promptJson(input, {
    model: config.llm.extractionModel,
    caller,
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              index: { type: 'integer' },
              memorable: { type: 'boolean' },
              facts: { type: 'array', items: { type: 'string' } },
            },
            required: ['index', 'memorable', 'facts'],
          },
        },
      },
      required: ['turns'],
    },
  });
  if (!Array.isArray(result?.turns)) throw new Error('stop-spool classifier returned no turns array');
  const byIndex = new Map(result.turns.map((turn) => [Number(turn.index), turn]));
  return userMessages.map((_, index) => {
    const turn = byIndex.get(index);
    if (!turn || !Array.isArray(turn.facts)) throw new Error(`stop-spool classifier omitted turn ${index}`);
    if (turn.memorable !== true) return [];
    return turn.facts
      .filter((fact) => typeof fact === 'string')
      .map((fact) => fact.trim())
      .filter((fact) => fact.length >= 8 && fact.length <= 200);
  });
}

/**
 * Save classified facts through the regular AUDM ingest pipeline.
 *
 * `throwOnError` lets the spool replayer surface a save failure (so the entry
 * stays spooled for the next attempt); the live hook keeps the legacy
 * best-effort behaviour (log + continue) so it never blocks Claude.
 */
async function saveFacts(facts, { podUids = [], throwOnError = false } = {}) {
  const { ingestAtomicFacts } = await import('../ingestion/pipeline.js');
  const config = (await import('../config.js')).default;

  try {
    await ingestAtomicFacts({
      facts,
      namespace: config.defaults.namespace,
      podUids,
    });
  } catch (err) {
    process.stderr.write(`[sigil:stop] save failed: ${maskSecrets(err.message)}\n`);
    if (throwOnError) throw err;
  }

  // Refresh hot-context so the new fact shows up at next session start
  try {
    const { updateContextSnapshot } = await import('../memory/facts/hot-context.js');
    await updateContextSnapshot({ namespace: config.defaults.namespace });
  } catch { /* best effort */ }
}

export { classifyTurn, classifyTurns, saveFacts, CLASSIFIER_PROMPT };
