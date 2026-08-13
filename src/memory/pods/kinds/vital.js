/**
 * vital kind — virtual; surfaces facts with importance_score=5 globally,
 * independent of pod membership.
 *
 * Unlike claude_session / project / person / playbook, vital has no row
 * in the pod table. It's a *retrieval-time* facet that always-active
 * pulls top vital facts by importance score and recent access count.
 * Hot-context special-cases this kind via the `fetchFacts` method
 * (registry checks for it before doing the membership-JOIN path).
 *
 * This preserves the pre-registry behavior of vital facts (today's
 * `vitalFactsByImportance` in hot-context.js) but routes it through
 * the kind contract so the hot-context blend logic doesn't have to
 * special-case vital with hardcoded paths.
 */

import cortexDb from '../../../db/cortex.js';
import config from '../../../config.js';
import { scopeVisibility, resolveViewer } from '../../visibility.js';

export const POD_TYPE = '__vital__'; // sentinel, never stored in DB

const VIRTUAL_SCOPE = ['__virtual:vital__'];

export const vitalKind = {
  name: 'vital',
  description: 'Facts marked importance=5 (vital), surfaced globally',
  identityField: null,
  attrsSchema: {},
  visibility: 'public',
  activeMode: 'always',
  hotContextBudget: 6,
  retrievalWeights: { recency: 0.5, relevance: 1.0 },
  importanceDefault: 5,
  ttlDays: null,
  schemaDocPath: 'kinds/vital.schema.md',
  writePolicy: 'open',
  // Sentinel scope — non-empty so activeKinds() considers vital active
  // for any context, but the value is never used as a pod uid.
  resolveActiveScope: async () => VIRTUAL_SCOPE,
  // Hot-context calls this when present, skipping the membership JOIN path.
  // Visibility-scoped even though the KIND is 'public'. Those are different
  // questions: the kind says a vital fact is not confined to some pod, while
  // fact.visibility says which agent it was addressed to. This path is the one
  // that most needs the check — an assistant-directed instruction is exactly
  // the kind of thing the extractor marks importance=vital ("vital for core
  // preferences"), and vital facts are injected into every session regardless
  // of pod. Unscoped, "call me sir" told to one agent would reach all of them.
  fetchFacts: async (ctx = {}, { slots = 8, namespace } = {}) => {
    const ns = namespace || ctx.namespace || config.defaults.namespace;
    return scopeVisibility(cortexDb('fact as f'), await resolveViewer('own'), 'f')
      .leftJoin('fact_lifecycle as fl', 'fl.fact_id', 'f.id')
      .where({ 'f.status': 'active', 'f.namespace': ns })
      .where((qb) => {
        qb.where('f.importance', 'vital').orWhere('f.importance_score', 5);
      })
      .orderByRaw('COALESCE(fl.access_count, 0) DESC, f.created_at DESC')
      .limit(slots)
      .pluck('f.content');
  },
};
