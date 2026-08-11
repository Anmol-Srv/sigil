/**
 * Fact visibility — who may retrieve a fact, as distinct from who wrote it.
 *
 * The whole feature exists for one asymmetry. Almost everything the user tells
 * one agent is equally true for the others: a bug in the GUI is a bug in the
 * GUI whether the cloud agent found it or the laptop did, and a memory system
 * that siloed those would be worse than no memory at all. But a thin slice of
 * what gets said to an agent is addressed TO that agent — "call me sir",
 * "answer in bullets", "you're my reviewer, not my author" — and replaying
 * those to a different agent puts words in its mouth the user never chose.
 *
 * So: share by default, exclude narrowly and deliberately. That is what every
 * multi-device system surveyed settles on (Chrome syncs everything and carves
 * out categories; CouchDB replicates everything absent a filter; Keychain's
 * per-item flag is conservative at the primitive but set to "sync" by every
 * first-party caller). The narrow exclusions are the part that gets designed.
 *
 * Three values, one column, principal implied by the value:
 *
 *   shared  every device, every agent. The default and the vast majority.
 *   agent   only the agent that wrote it. The "call me sir" class. Chosen as
 *           the persona boundary because that is what the instruction is about
 *           — Mem0 draws the same line, using agent_id for "one bot's
 *           personality/voice" and user_id for everything shared across them.
 *   device  only the install that wrote it. Machine-local truth: a checkout
 *           path, a port that is only listening here, a local GPU.
 *
 * The reader side is deliberately separate from the stored value: a viewer of
 * null means "no scoping", which is what a human searching their own memory
 * gets. Hiding a user's own facts from the user is never the goal — the goal
 * is keeping one agent from speaking in another agent's voice.
 */

export const VISIBILITIES = ['shared', 'agent', 'device'];
export const DEFAULT_VISIBILITY = 'shared';

/**
 * Coerce anything into a legal visibility.
 *
 * Fails OPEN, to 'shared'. An unrecognised value means we don't know the
 * intent, and the cost of the two mistakes is not symmetric: wrongly sharing a
 * stylistic preference is a small annoyance the user can correct, while
 * wrongly hiding a fact removes it from recall everywhere with no signal that
 * anything is missing. Silent under-retrieval is the failure mode this whole
 * system exists to prevent.
 */
export function normalizeVisibility(value) {
  return VISIBILITIES.includes(value) ? value : DEFAULT_VISIBILITY;
}

/**
 * The principal doing the reading, for buildFactFilters({ viewer }).
 *
 * Returns null when the caller should see everything — which is the right
 * answer for a human at the CLI and the wrong answer for an agent acting on
 * their behalf.
 *
 * @param {'own'|'any'} mode
 */
export async function resolveViewer(mode = 'own') {
  if (mode === 'any') return null;

  const { currentAgent, currentDeviceId } = await import('../daemon/request-context.js');
  return { agent: currentAgent(), deviceId: currentDeviceId() };
}

/**
 * Apply the same visibility rule to a knex query builder.
 *
 * The search path builds raw SQL and gets its clause from buildFactFilters;
 * hot-context and the pod/list paths use the query builder. Both must agree —
 * a fact hidden from search but injected into CLAUDE.md would defeat the whole
 * point, since injection is the louder channel.
 *
 * @param {import('knex').Knex.QueryBuilder} qb
 * @param {{agent:string|null,deviceId:number|null}|null} viewer  null = no scoping
 * @param {string} alias  table alias holding the fact columns
 */
export function scopeVisibility(qb, viewer, alias = 'fact') {
  if (!viewer) return qb;
  return qb.whereRaw(
    `(${alias}.visibility = 'shared'
      OR (${alias}.visibility = 'agent'  AND ${alias}.created_by_agent IS NOT DISTINCT FROM ?)
      OR (${alias}.visibility = 'device' AND ${alias}.created_by_device_id IS NOT DISTINCT FROM ?))`,
    [viewer.agent ?? null, viewer.deviceId ?? null],
  );
}

/**
 * Does this fact, written now, belong to one agent rather than to the user?
 *
 * Deliberately conservative and deliberately NOT an LLM call. The classifier
 * already decides route, category and importance; adding a fourth judgement
 * to that prompt would make every save's scope depend on a sampled token, and
 * a wrong sample here means a fact quietly vanishes from every other agent.
 *
 * The signal we act on instead is structural: an instruction phrased in the
 * second person about how to BEHAVE ("call me sir", "you should always...",
 * "respond in bullets") is addressed to the assistant. A statement about the
 * world, or about the user in the third person, is not — and stays shared.
 *
 * Returns 'agent' or 'shared'. Never returns 'device'; machine-local scope is
 * a deliberate act, so it is caller-supplied only.
 */
export function inferVisibility(content, { category } = {}) {
  const text = String(content || '').toLowerCase().trim();
  if (!text) return DEFAULT_VISIBILITY;

  // Only ever narrows facts that are already about style/preference/persona.
  // A `decision` or `architecture` fact is about the work, and no amount of
  // second-person phrasing should pull it out of the shared pool.
  const NARROWABLE = new Set(['preference', 'opinion', 'personal', 'convention', 'workflow']);
  if (category && !NARROWABLE.has(category)) return DEFAULT_VISIBILITY;

  // Addressed to the assistant AND about how it should behave. Both halves are
  // required: "you are on the sigil repo" is second-person but not an
  // instruction, and "always use tabs" is an instruction but about the code.
  const ADDRESSES_ASSISTANT = /\b(you|your|yourself|assistant|agent)\b/;
  const IS_BEHAVIOURAL = /\b(call|address|refer to|respond|reply|answer|speak|talk|behave|act|greet|sign off|tone|voice|persona|style)\b/;

  if (ADDRESSES_ASSISTANT.test(text) && IS_BEHAVIOURAL.test(text)) return 'agent';

  // "Call me sir" / "address me as ..." carry the instruction without ever
  // naming the addressee — the imperative mood IS the second person. This is
  // the exact phrasing the feature was reported against, so it gets its own
  // rule rather than relying on the pronoun test above.
  if (/^(please\s+)?(call|address|refer to)\s+(me|the user)\b/.test(text)) return 'agent';
  if (/\b(wants?|likes?|prefers?)\s+to\s+be\s+(called|addressed|referred to)\b/.test(text)) return 'agent';

  return DEFAULT_VISIBILITY;
}
