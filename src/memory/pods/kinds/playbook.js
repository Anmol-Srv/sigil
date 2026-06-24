/**
 * playbook kind — user-authored workflows, debug recipes, runbooks.
 *
 * This is the procedural-memory slot the CoALA framework names and that
 * the current Sigil schema doesn't capture: how the user *does* things,
 * not what they know about. A playbook pod holds a set of facts (steps,
 * checks, gotchas) about a recurring procedure: "how I debug a payment
 * webhook signature failure", "how I deploy mycohort-api on a Friday".
 *
 * Identity: user-given slug. Always-active when the active project pod
 * matches the playbook's `project` attr — so the deploy runbook for
 * mycohort surfaces in mycohort sessions and is invisible in cortex
 * sessions.
 *
 * Created via CLI: `sigil pod create --kind=playbook --name=<slug>
 *                    --project=<name> --content=<markdown>`
 * (CLI wiring lands in Task #10 — for 0.10.0 we just create the kind.)
 */

import cortexDb from '../../../db/cortex.js';
import config from '../../../config.js';
import { parseAttrs } from '../attrs.js';

export const POD_TYPE = 'playbook';

export const playbookKind = {
  name: 'playbook',
  description: 'A reusable workflow or debug recipe (procedural memory)',
  identityField: 'slug',
  attrsSchema: {
    slug: 'string',
    project: 'string',
    description: 'string',
    tags: 'array',
  },
  visibility: 'shared',
  activeMode: 'always',
  hotContextBudget: 3,
  retrievalWeights: { recency: 0.3, relevance: 1.0 },
  importanceDefault: 3,
  ttlDays: null,
  schemaDocPath: 'kinds/playbook.schema.md',
  writePolicy: 'origin-only',
  resolveActiveScope: async (ctx = {}) => {
    // Surface playbooks whose attrs.project matches the active project
    // (or all playbooks if no project context). Falls back to empty
    // when neither cursor nor ctx carries a cwd.
    const ns = ctx.namespace || config.defaults.namespace;
    const projectName = await resolveActiveProjectName(ctx);
    try {
      const query = cortexDb('pod')
        .where({ podType: POD_TYPE, namespace: ns, status: 'active' })
        .select('uid', 'attrs');
      const rows = await query;
      if (!projectName) return rows.map((r) => r.uid);
      const match = rows.filter((r) => {
        const attrs = parseAttrs(r.attrs);
        return !attrs.project || attrs.project === projectName;
      });
      return match.map((r) => r.uid);
    } catch {
      return [];
    }
  },
};

async function resolveActiveProjectName(ctx) {
  // Prefer explicit ctx, then derive from cwd via the project kind's
  // helpers, then fall back to null.
  if (ctx.project) return ctx.project;
  if (!ctx.cwd) {
    try {
      const { getActiveCursor } = await import('../active-session.js');
      const cursor = await getActiveCursor();
      ctx = { ...ctx, cwd: cursor?.cwd };
    } catch {
      return null;
    }
  }
  if (!ctx.cwd) return null;
  try {
    const { deriveProjectRoot } = await import('./project.js');
    const root = deriveProjectRoot(ctx.cwd);
    return root ? root.split('/').pop() : null;
  } catch {
    return null;
  }
}

export function formatForDisplay(pod) {
  const a = parseAttrs(pod.attrs);
  return {
    uid: pod.uid,
    name: pod.name,
    slug: a.slug,
    project: a.project,
    description: a.description,
    tags: a.tags ?? [],
    memberFactCount: pod.memberFactCount,
    memberDocCount: pod.memberDocCount,
  };
}
