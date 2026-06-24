/**
 * claude_session kind — one pod per Claude Code session.
 *
 * Identity: Claude Code session_id (from hook stdin envelope).
 * Lifecycle: opens on first hook fire, closes on SessionEnd (or after 6h
 * of cursor inactivity). One active at a time per install.
 *
 * Migrated from the pre-registry types/session.js — same DB shape,
 * stored as pod_type='claude_session' (the 0.10.0 migration rewrote
 * the old 'session' rows). The legacy formatForDisplay / buildAttrs /
 * defaultName helpers remain exported here for cli.js, active-session.js,
 * and any older callers that haven't moved to the registry surface yet.
 */

import { getActiveSessionPodUid } from '../active-session.js';
import { parseAttrs } from '../attrs.js';

export const POD_TYPE = 'claude_session';

export const claudeSessionKind = {
  name: 'claude_session',
  description: 'Claude Code session',
  identityField: 'session_id',
  attrsSchema: {
    session_id: 'string',
    transcript_path: 'string',
    cwd: 'string',
    turn_count: 'number',
    model: 'string',
    conclusion: 'string',
    summary: 'string',
  },
  visibility: 'private',
  activeMode: 'singleton-live',
  hotContextBudget: 6,
  retrievalWeights: { recency: 1.0, relevance: 0.7 },
  importanceDefault: 2,
  ttlDays: 90,
  schemaDocPath: 'kinds/claude_session.schema.md',
  writePolicy: 'origin-only',
  resolveActiveScope: async () => {
    try {
      const uid = await getActiveSessionPodUid();
      return uid ? [uid] : [];
    } catch {
      return [];
    }
  },
};

export function buildAttrs({
  sessionId,
  transcriptPath = null,
  cwd = null,
  turnCount = 0,
  model = null,
  conclusion = null,
  summary = null,
}) {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    turn_count: turnCount,
    model,
    conclusion,
    summary,
  };
}

export function defaultName({ sessionId, startedAt = new Date() } = {}) {
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const iso = d.toISOString().replace('T', ' ').slice(0, 16);
  const short = sessionId ? sessionId.slice(0, 8) : 'unknown';
  return `claude-session ${iso} (${short})`;
}

export function formatForDisplay(pod) {
  const a = parseAttrs(pod.attrs);
  return {
    uid: pod.uid,
    name: pod.name,
    sessionId: a.session_id ?? pod.externalId,
    transcriptPath: a.transcript_path,
    cwd: a.cwd,
    model: a.model,
    turnCount: a.turn_count ?? 0,
    conclusion: a.conclusion,
    startedAt: pod.startedAt,
    endedAt: pod.endedAt,
    memberFactCount: pod.memberFactCount,
    memberDocCount: pod.memberDocCount,
  };
}
