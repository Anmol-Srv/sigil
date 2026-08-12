/**
 * directive kind — virtual; standing instructions about how to work with the
 * user, always injected regardless of what the current prompt is about.
 *
 * Why this exists as its own kind rather than riding on `vital`:
 *
 * Recall is query-driven. The UserPromptSubmit hook searches Sigil with the
 * user's literal prompt, so a fact only surfaces when it resembles what was
 * just asked. That works for subject-matter facts and fails completely for
 * standing instructions — "keep explanations short" is relevant to EVERY
 * answer and semantically similar to almost NO prompt. The user notices this
 * as the assistant repeatedly ignoring a preference they already stated, which
 * is exactly the complaint that produced this file.
 *
 * The hot-context block is the query-independent channel that fixes it, but
 * before this kind its always-on slots were owned by `vital` — and vital is
 * both pod-blind and, because the thought fast-path stamps every remembered
 * fact importance=vital, effectively unfiltered. In practice the six always-on
 * slots filled with whatever had been ingested most recently, from any
 * project. Directives never got in.
 *
 * So directives get their own reserved budget, taken before vital in the blend
 * (registration order in kinds/index.js is the blend order). A user-level
 * instruction outranks project trivia for the scarcest space in the system.
 *
 * ponytail: category-based selection, no dedicated column. If directives ever
 * need to be pinned individually, add `fact.pinned` and OR it in here.
 */

import cortexDb from '../../../db/cortex.js';
import config from '../../../config.js';
import { scopeVisibility, resolveViewer } from '../../visibility.js';

export const POD_TYPE = '__directive__'; // sentinel, never stored in DB

const VIRTUAL_SCOPE = ['__virtual:directive__'];

/**
 * Categories that carry "how to work with me" rather than "what is true".
 *
 * PERSONAL_CATEGORIES minus `experience` (projects built, skills acquired —
 * biography, not instruction), plus `convention` (naming rules, team
 * standards, which are directives even though they're filed as knowledge).
 *
 * `workflow` is deliberately excluded despite sounding directive: in this
 * vocabulary it means "process flows, state transitions" — project mechanics
 * that would flood the slots with exactly the off-project noise this kind
 * exists to displace.
 */
const DIRECTIVE_CATEGORIES = ['preference', 'opinion', 'personal', 'convention'];

export const directiveKind = {
  name: 'directive',
  description: 'Standing instructions about how to work with the user',
  identityField: null,
  attrsSchema: {},
  visibility: 'private',
  activeMode: 'always',
  hotContextBudget: 5,
  retrievalWeights: { recency: 1.0, relevance: 0.5 },
  importanceDefault: 5,
  ttlDays: null,
  writePolicy: 'open',
  // Sentinel scope — non-empty so activeKinds() treats the kind as active in
  // any context, but the value is never used as a pod uid.
  resolveActiveScope: async () => VIRTUAL_SCOPE,
  fetchFacts: async (ctx = {}, { slots = 5, namespace } = {}) => {
    const ns = namespace || ctx.namespace || config.defaults.namespace;
    // Visibility-scoped for the same reason vital is: this writes straight
    // into an agent's prompt, and an instruction addressed to one agent must
    // not put words in another's mouth.
    return scopeVisibility(cortexDb('fact as f'), await resolveViewer('own'), 'f')
      .where({ 'f.status': 'active', 'f.namespace': ns })
      .whereIn('f.category', DIRECTIVE_CATEGORIES)
      // Newest first, unlike vital's access_count ordering. A directive is a
      // standing instruction, so the most recent statement is the operative
      // one — "actually, keep it short" must beat the older preference it
      // corrects. Ranking by access_count would do the opposite: injected
      // facts are never "accessed" (only searched ones are), so the longest-
      // standing entries would ossify at the top and corrections would never
      // surface.
      .orderByRaw('f.created_at DESC')
      .limit(slots)
      .pluck('f.content');
  },
};

export { DIRECTIVE_CATEGORIES };
