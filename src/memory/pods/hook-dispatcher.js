/**
 * Hook → pod dispatcher.
 *
 * Hooks (stop, post-tool-use, session-end, user-prompt-submit) used to
 * resolve one pod — the active claude_session — and attach facts to it.
 * In 0.10.0, with project/person/playbook kinds in the registry, every
 * hook fact should land in *all* relevant pods: the active session +
 * the active project (+ later, the active agent in 0.11.0). This
 * dispatcher is the single seam that walks the registry, opens/refreshes
 * pods for every kind that has a lifecycle hook for this event, and
 * returns the flat list of pod uids the caller should attach to.
 *
 * Kinds outside this dispatcher's purview:
 *   • person  — attached via the entity-linker path when a person is
 *                mentioned. Orthogonal to hook events.
 *   • playbook — user-authored, never auto-created by hooks.
 *   • vital   — virtual, no pod row.
 */

import { ensureActiveSession } from './active-session.js';
import { ensureProjectPod } from './kinds/project.js';

// Ensure every kind whose lifecycle.open should fire on a generic hook
// event has its pod open and up-to-date. Returns:
//   { sessionPod, projectPod, podUids }
// podUids is the flat array the caller passes to ingestDocument().
//
// Idempotent: same input → same pods, no duplicates created.
export async function ensureActivePodsForHook({
  sessionId,
  cwd = null,
  transcriptPath = null,
  model = null,
  namespace = null,
}) {
  let sessionPod = null;
  if (sessionId) {
    try {
      sessionPod = await ensureActiveSession({
        sessionId,
        transcriptPath,
        cwd,
        model,
        namespace,
      });
    } catch {
      sessionPod = null;
    }
  }

  let projectPod = null;
  if (cwd) {
    try {
      projectPod = await ensureProjectPod({ cwd, namespace });
    } catch {
      projectPod = null;
    }
  }

  // ONE owner, and the project wins.
  //
  // This used to return [sessionPod, projectPod] — both, flat, same role — so
  // every save attached the same fact and the same document to two pods. The
  // visible result: a `claude_session …` pod per session mirroring the project's
  // contents, with the pod list double-counting everything (one fact showing as
  // 1 fact in `mycohort-api` AND 1 fact in `claude-session 2026-08-08 09:35`).
  // It also made "which pod owns this fact" unanswerable.
  //
  // The project is the durable scope — it's what you come back to next week —
  // so it OWNS the write ('primary'). The session records the same facts as
  // 'mention': enough to answer "what happened in this session" without
  // claiming them. The first cut of this fix dropped the session attachment
  // entirely, which read as clean but quietly broke two things — session pods
  // accumulated forever with 0 facts, and end-of-session synthesis, which reads
  // the session pod's own fact members, never once fired for a session run
  // inside a project.
  //
  // Nothing is lost at read time: hot-context blends kinds with content-level
  // dedup, so the duplicate session copy was already being discarded there, and
  // podScope:'auto' still unions every active kind.
  const owner = projectPod || sessionPod;
  const podUids = owner ? [{ uid: owner.uid, role: 'primary' }] : [];

  // The session ALSO records what passed through it, as a 'mention' — which
  // does not bump the pod's counters, so nothing double-counts and ownership
  // stays unambiguous. Without this the session pod was inert: end-of-session
  // synthesis reads its own fact members and needs three, so for any session
  // run inside a project it found zero and silently never produced a summary.
  if (sessionPod && owner !== sessionPod) {
    podUids.push({ uid: sessionPod.uid, role: 'mention' });
  }

  return { sessionPod, projectPod, podUids };
}
