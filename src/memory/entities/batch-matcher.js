/**
 * One LLM call that decides EVERY entity-dedup question in an episode.
 *
 * The per-pair path (verifyEmbeddingMatch) asks "is mention A the same thing as
 * candidate B?" once per pair, in nested loops — per mention, per candidate. A
 * six-entity save therefore spent six sequential ~4s calls answering six
 * independent yes/no questions, and all six were decidable before the first one
 * ran: the candidate sets come from a vector query, not from any LLM output.
 * That was ~26s of a 49s save.
 *
 * Two things make batching strictly better here, not just cheaper:
 *
 *  1. Cross-mention renames get EASIER. The per-pair path can't see that two
 *     other mentions in the same sentence are the same thing, which is why
 *     resolveEntity has a whole Stage 3 that threads previously-resolved
 *     entities into the next mention's candidate list — a sequential workaround
 *     for a missing view. Here every mention and every candidate is in one
 *     prompt, so "Smara is now named Sigil" is visible directly, and a mention
 *     may resolve to a SIBLING mention (`same_as_mention`).
 *  2. The decisions were never independent in meaning, only in execution — two
 *     mentions claiming the same candidate is a conflict the per-pair path
 *     cannot even detect.
 *
 * The caller falls back to the per-pair cascade whenever this returns null, so a
 * bad parse costs one wasted call and never changes what gets stored.
 */
import { prompt as llmPrompt } from '../../lib/llm.js';
import config from '../../config.js';

const MAX_EPISODE_CHARS = 1500;   // same budget the per-pair prompt used
const MAX_CANDIDATES_PER_MENTION = 3;

/**
 * @param {Array} mentions  [{ name, entityType, candidates: [{id,name,types,aliases,similarity}] }]
 * @param {string} episodeText
 * @returns {Promise<Map<string, object>|null>}  mention name → decision, or null
 *   if the model gave us nothing usable. Decision shape:
 *   { sameAsId?: number, sameAsMention?: string, rename: bool, currentName: string|null, reason: string }
 */
export async function matchEntitiesBatch(mentions, episodeText) {
  if (!mentions?.length) return new Map();

  const raw = await llmPrompt(buildPrompt(mentions, episodeText), {
    model: config.llm.entityModel,
    caller: 'entity-matcher-batch',
  });

  return parsePlan(raw, mentions);
}

function buildPrompt(mentions, episodeText) {
  const blocks = mentions.map((m, i) => {
    const cands = (m.candidates || []).slice(0, MAX_CANDIDATES_PER_MENTION);
    const lines = cands.length
      ? cands.map((c) => {
        const aliases = (c.aliases || []).filter(Boolean);
        const sim = c.similarity > 0 ? `${(c.similarity * 100).toFixed(0)}% name similarity` : 'judge on the passage alone';
        return `      - id ${c.id}: "${c.name}" (types: ${(c.types || []).join(', ') || 'unknown'})`
             + `${aliases.length ? ` [also known as: ${aliases.join(', ')}]` : ''} — ${sim}`;
      }).join('\n')
      : '      (none)';
    return `  ${i + 1}. "${m.name}" (type: ${m.entityType})\n     existing candidates:\n${lines}`;
  }).join('\n');

  return `You are deduplicating entity mentions against a memory store. Decide, for EVERY mention below, whether it refers to something already stored, or to another mention in this same list, or is new.

Source passage the mentions were extracted from:
---
${String(episodeText || '').slice(0, MAX_EPISODE_CHARS)}
---

Mentions to decide:
${blocks}

Decision rules:
- "same_as_id" = the id of the candidate that refers to the SAME real-world thing — including renames, abbreviations ("NYC" / "New York City"), and common-knowledge equivalents. Use null when none match.
- "same_as_mention" = the exact name of ANOTHER mention in this list that refers to the same thing, when no stored candidate does. Use null otherwise. Never point a mention at itself, and never form a cycle.
- "rename" = true ONLY when the passage says one name has REPLACED the other ("X is now named Y", "X was renamed to Y", "we used to call this X"). A plain synonym is NOT a rename.
- "current_name" = which name is canonical going forward. Only meaningful when rename is true; otherwise null.
- If you cannot tell, everything is null and rename is false. Do not guess.

Respond with STRICT JSON only, no markdown, no prose — one object per mention, in the same order:
{"decisions":[{"mention":"<name verbatim>","same_as_id":<number|null>,"same_as_mention":"<name|null>","rename":<bool>,"current_name":"<name|null>","reason":"one short sentence"}]}`;
}

/**
 * Parse the plan, keeping only decisions we can act on. Anything the model got
 * structurally wrong (an id it was never offered, a mention that isn't in the
 * batch, a self-reference) is DROPPED rather than trusted — a dropped decision
 * degrades to "create a new entity", which is the safe direction. Inventing a
 * merge would silently fuse two unrelated things in the user's memory.
 */
function parsePlan(raw, mentions) {
  const json = extractJson(raw);
  const list = Array.isArray(json?.decisions) ? json.decisions : null;
  if (!list) return null;

  const byName = new Map(mentions.map((m) => [m.name, m]));
  const out = new Map();

  for (const d of list) {
    const m = byName.get(d?.mention);
    if (!m) continue;

    const offered = new Set((m.candidates || []).map((c) => c.id));
    const sameAsId = offered.has(d.same_as_id) ? d.same_as_id : null;

    // A sibling reference must name a DIFFERENT mention that is actually here.
    const sib = typeof d.same_as_mention === 'string' ? d.same_as_mention : null;
    const sameAsMention = sib && sib !== m.name && byName.has(sib) ? sib : null;

    out.set(m.name, {
      sameAsId,
      sameAsMention: sameAsId ? null : sameAsMention, // a stored match wins
      rename: d.rename === true && !!(sameAsId || sameAsMention),
      currentName: typeof d.current_name === 'string' ? d.current_name : null,
      reason: typeof d.reason === 'string' ? d.reason : '',
    });
  }

  return out.size ? out : null;
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
  return null;
}

export { buildPrompt, parsePlan };
