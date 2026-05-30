/**
 * Hot context — surfaces the most relevant facts for automatic injection
 * into every new Claude session via ~/.sigil/CLAUDE.md.
 *
 * 0.10.0: rewritten as a kind-driven blend. The four-pass hardcoded loop
 * (session → person → vital → reserved-for-project) becomes a generic
 * iteration over `registry.activeKinds(ctx)`. Each kind declares its
 * hotContextBudget, retrievalWeights, and a way to fetch facts —
 * either pod-backed (default: factsInPodsByRecency over the kind's
 * active pod uids) or virtual (custom `fetchFacts` method, used by the
 * `vital` kind which surfaces facts by importance globally).
 *
 * The hot-context blend now expands automatically as new kinds are
 * registered. Project pods (kind=project) fill the budget that was
 * reserved-but-unused in 0.9.x; playbook pods (procedural memory) get
 * their own slots; new kinds in 0.11.0+ (agent, codex_session, etc.)
 * slot in without touching this file.
 */

import cortexDb from '../../db/cortex.js';
import config from '../../config.js';
import { SIGIL_MD_PATH } from '../../lib/paths.js';

import '../pods/kinds/index.js'; // side-effect: register built-in kinds
import { activeKinds } from '../pods/registry.js';

const CONTEXT_LIMIT = 20;

export async function getHotFacts({
  namespace,
  limit = CONTEXT_LIMIT,
  ctx: callerCtx = {},
} = {}) {
  const ns = namespace || config.defaults.namespace;
  const ctx = { ...callerCtx, namespace: ns };
  if (!ctx.cwd) {
    ctx.cwd = await readCwdFromCursor();
  }

  const active = await activeKinds(ctx);

  // Run each kind's fetch in parallel. Custom fetchFacts (vital) wins;
  // otherwise default to the pod-membership recency join.
  const lists = await Promise.all(
    active.map(async ({ kind, scope }) => {
      try {
        if (typeof kind.fetchFacts === 'function') {
          return await kind.fetchFacts(ctx, {
            slots: kind.hotContextBudget,
            namespace: ns,
          });
        }
        return await factsInPodsByRecency(scope, ns, kind.hotContextBudget);
      } catch {
        return [];
      }
    }),
  );

  // Merge in registration order with content-level dedup. Each kind's
  // own budget acts as a quota; the overall `limit` caps the blend.
  const seen = new Set();
  const blended = [];
  for (const list of lists) {
    for (const content of list) {
      if (!content || seen.has(content)) continue;
      seen.add(content);
      blended.push(content);
      if (blended.length >= limit) return blended;
    }
  }

  // Precision-first backfill. Only fall back to namespace-global recency when
  // the kind-driven blend produced NOTHING — i.e. a genuine fresh install with
  // no pods and no vital facts. An established project that merely underflows
  // its budget keeps a SMALL, on-project context rather than getting padded
  // with off-project recency (that padding was the cross-project leak: a
  // sigil session showing payment-webhook facts). Half-full-and-relevant beats
  // full-and-polluted. Fresh installs still get something so day-one isn't
  // empty; once any pod/vital fact exists, the blend stays scoped.
  if (blended.length === 0) {
    const filler = await cortexDb('fact as f')
      .leftJoin('fact_lifecycle as fl', 'fl.fact_id', 'f.id')
      .where({ 'f.status': 'active', 'f.namespace': ns })
      .orderByRaw('COALESCE(fl.last_accessed_at, f.created_at) DESC')
      .limit(limit)
      .pluck('f.content');
    for (const content of filler) {
      if (!content || seen.has(content)) continue;
      seen.add(content);
      blended.push(content);
      if (blended.length >= limit) break;
    }
  }

  return blended.slice(0, limit);
}

// Shared helper — pod-backed kinds default to this for their fetch.
// Ranks by importance_score × recency-decay, falling back to created_at
// when fact_lifecycle is absent. Exposed for kind authors who want to
// customise their own fetchFacts but reuse the default scoring.
export async function factsInPodsByRecency(podUids, namespace, slots) {
  if (!Array.isArray(podUids) || podUids.length === 0) return [];
  const real = podUids.filter((u) => typeof u === 'string' && !u.startsWith('__virtual:'));
  if (real.length === 0) return [];
  return cortexDb('fact as f')
    .join('pod_membership as pm', function () {
      this.on('pm.member_id', '=', 'f.id')
          .andOnVal('pm.member_type', '=', 'fact');
    })
    .join('pod as p', 'p.id', 'pm.pod_id')
    .leftJoin('fact_lifecycle as fl', 'fl.fact_id', 'f.id')
    .whereIn('p.uid', real)
    .where({ 'f.status': 'active', 'f.namespace': namespace })
    .orderByRaw(`
      COALESCE(f.importance_score, 2) DESC,
      COALESCE(fl.last_accessed_at, f.created_at) DESC
    `)
    .limit(slots)
    .pluck('f.content');
}

async function readCwdFromCursor() {
  try {
    const { getActiveCursor } = await import('../pods/active-session.js');
    const cursor = await getActiveCursor();
    return cursor?.cwd || null;
  } catch {
    return null;
  }
}

/**
 * Pure file-write: takes a fact list and stamps it into ~/.sigil/CLAUDE.md.
 * No DB access — safe to call on a lite-follower with the facts having
 * been fetched remotely.
 */
export async function writeSnapshotToFile({ facts, namespace }) {
  const fs = await import('node:fs/promises');
  if (!facts || !facts.length) return 0;

  const marker = '<!-- sigil-context -->';
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = [
    marker,
    `## Active Context  *(${facts.length} facts · refreshed ${date}${namespace ? ` · ns=${namespace}` : ''})*`,
    '',
    facts.map((f) => `- ${f}`).join('\n'),
    marker,
  ].join('\n');

  let existing = '';
  try { existing = await fs.readFile(SIGIL_MD_PATH, 'utf8'); } catch { /* file may not exist */ }

  const updated = existing.includes(marker)
    ? existing.replace(new RegExp(`${marker}[\\s\\S]*?${marker}`), block)
    : existing + (existing.trim() ? '\n\n' : '') + block + '\n';

  await fs.writeFile(SIGIL_MD_PATH, updated, 'utf8');
  return facts.length;
}

/**
 * Convenience: fetch + write in one call. Used by the remember/ingest
 * post-hooks that don't need to distinguish local vs remote.
 */
export async function updateContextSnapshot({ namespace, limit, ctx } = {}) {
  const facts = await getHotFacts({ namespace, limit, ctx });
  return writeSnapshotToFile({ facts, namespace });
}
