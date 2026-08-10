/**
 * The knowledge-base owner as a first-class entity.
 *
 * Facts about the owner almost never name them. They say "User prefers concise
 * responses", not "Anmol prefers concise responses". The graph extractor is told
 * to skip generic terms, and relationship endpoints must appear verbatim in the
 * fact text — so the subject of every preference fact was dropped, and each
 * preference landed as an orphan topic with nothing to attach it to. A real
 * store ended up with 28 topics, zero people, and its owner ("anmol") typed as a
 * topic holding exactly one fact.
 *
 * The fix is to give that subject a name. `identity.name` is already captured
 * during setup, so the owner can be resolved once as a `person` entity, and
 * every self-reference — "user", "I", "my" — routed to it.
 */
import { getConfig } from '../../setup/config-store.js';
import { resolveEntity } from './resolver.js';
import { setPrimaryEntityType } from './store.js';

/**
 * How the owner shows up in a fact, in the extractor's output, or in prose.
 * `user` is what the graph prompt is told to emit; the rest cover first-person
 * phrasing that reaches the same place.
 */
const SELF_ALIASES = new Set(['user', 'the user', 'i', 'me', 'my', 'myself', 'owner', 'the owner']);

/** The owner's name from setup, or null when setup never captured one. */
export function selfName() {
  try {
    const n = getConfig()?.identity?.name;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  } catch {
    return null; // config unreadable — behave as if no owner is known
  }
}

/** Does this entity name refer to the owner? Matches aliases and their own name. */
export function isSelfReference(name) {
  if (typeof name !== 'string') return false;
  const k = name.trim().toLowerCase();
  if (!k) return false;
  if (SELF_ALIASES.has(k)) return true;
  const own = selfName();
  return Boolean(own) && own.toLowerCase() === k;
}

/**
 * Facts whose subject is the owner, matched without an LLM.
 *
 * Deliberately narrow: it requires a preference/identity verb after the subject,
 * so "User must authenticate before calling the API" — a fact about a software
 * user role — doesn't get attached to a person. Missing a fact is recoverable;
 * silently filing an API note under someone's identity is not.
 */
const OWNER_SUBJECT = [
  /^\s*(?:the\s+)?users?['’]?s?\s+(?:name|preference|style)\b/i,
  /^\s*(?:the\s+)?user\s+(?:prefers?|likes?|dislikes?|hates?|wants?|uses?|avoids?|needs?|works?|runs?|is|was|has|had|always|never|doesn['’]?t|does\s+not)\b/i,
  // First person needs no verb gate: a fact that opens with "I"/"my" is about
  // the owner by construction, and the possessive takes any noun ("My editor is
  // Neovim"). The lookahead demands whitespace or an apostrophe next, so "I/O
  // throughput…" stays out — a plain \b would let it through.
  /^\s*(?:i|me|my|mine|myself)(?=['’\s])/i,
  /^\s*(?:prefers?|likes?|dislikes?|avoids?)\s+/i,
];

/** True when the fact's subject is the knowledge-base owner. */
export function isOwnerFact(content) {
  if (typeof content !== 'string' || !content.trim()) return false;
  return OWNER_SUBJECT.some((re) => re.test(content));
}

/**
 * The owner's canonical entity, typed `person`, or null when setup captured no
 * name (in which case callers behave exactly as they did before).
 *
 * Goes through resolveEntity so an owner already in the graph as a topic —
 * which is how every existing store has it — is found by case-insensitive name
 * and retyped in place rather than duplicated.
 */
export async function resolveSelfEntity({ namespace, episodeText, episodeEntityIds = [] } = {}) {
  const name = selfName();
  if (!name) return null;
  try {
    const entity = await resolveEntity({
      name,
      entityType: 'person',
      description: 'the owner of this knowledge base',
      namespace,
      episodeText,
      episodeEntityIds,
    });
    if (!entity?.id) return null;
    // resolveEntity only appends to the multi-type list on an existing node, and
    // every person query reads the primary column — so an owner already stored
    // as a topic stays invisible without this. A person who is also a topic is
    // a person.
    return (await setPrimaryEntityType(entity.id, 'person')) || entity;
  } catch {
    return null; // never let owner resolution break an ingest
  }
}

export const __SELF_ALIASES = SELF_ALIASES;
