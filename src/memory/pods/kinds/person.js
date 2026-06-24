/**
 * person kind — one pod per person you have a relationship with.
 *
 * Identity: the *primary* platform handle (slack user_id → github username
 * → email), so partial-unique upserts on the dominant platform work.
 * entity_id is set to the canonical person-entity row.
 *
 * Migrated from types/person.js — same DB shape, full kind contract.
 * Legacy helpers (buildAttrs, primaryExternalId, mergePlatforms,
 * formatForDisplay) remain exported for resolver.js and cli.js callers.
 */

import cortexDb from '../../../db/cortex.js';
import config from '../../../config.js';
import { parseAttrs } from '../attrs.js';

export const POD_TYPE = 'person';

const PERSON_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const personKind = {
  name: 'person',
  description: 'A person you have a working relationship with',
  identityField: 'primary_handle',
  attrsSchema: {
    platforms: 'object',
    role: 'string',
    relationship: 'string',
    notes: 'string',
  },
  visibility: 'private',
  activeMode: 'rolling-window',
  hotContextBudget: 4,
  retrievalWeights: { recency: 1.0, relevance: 0.8 },
  importanceDefault: 3,
  ttlDays: null,
  schemaDocPath: 'kinds/person.schema.md',
  writePolicy: 'origin-only',
  resolveActiveScope: async (ctx = {}) => {
    const ns = ctx.namespace || config.defaults.namespace;
    try {
      const cutoff = new Date(Date.now() - PERSON_RECENT_WINDOW_MS);
      const rows = await cortexDb('pod as p')
        .join('pod_membership as pm', 'pm.pod_id', 'p.id')
        .join('fact_lifecycle as fl', 'fl.fact_id', 'pm.member_id')
        .where('pm.memberType', 'fact')
        .where('p.podType', 'person')
        .where('p.namespace', ns)
        .where('p.status', 'active')
        .where('fl.lastAccessedAt', '>=', cutoff)
        .distinct('p.uid');
      return rows.map((r) => r.uid);
    } catch {
      return [];
    }
  },
};

export function buildAttrs({
  platforms = {},
  role = null,
  relationship = null,
  notes = null,
}) {
  return { platforms, role, relationship, notes };
}

export function primaryExternalId(platforms = {}) {
  if (platforms.slack?.user_id) return `slack:${platforms.slack.user_id}`;
  if (platforms.github?.username) return `github:${platforms.github.username}`;
  if (platforms.email) return `email:${String(platforms.email).toLowerCase()}`;
  return null;
}

export function mergePlatforms(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!value) continue;
    merged[key] = { ...(merged[key] || {}), ...(typeof value === 'object' ? value : { value }) };
  }
  return merged;
}

export function formatForDisplay(pod) {
  const a = parseAttrs(pod.attrs);
  return {
    uid: pod.uid,
    name: pod.name,
    entityId: pod.entityId,
    platforms: a.platforms ?? {},
    role: a.role,
    relationship: a.relationship,
    notes: a.notes,
    memberFactCount: pod.memberFactCount,
    memberDocCount: pod.memberDocCount,
  };
}
