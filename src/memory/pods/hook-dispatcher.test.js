// One owner per write, and the project wins.
//
// The dispatcher used to return [sessionPod, projectPod] — both, flat, same role
// — so every save attached the same fact AND the same document to two pods. In a
// real store that showed up as a `claude_session 2026-08-08 09:35` pod mirroring
// the `mycohort-api` project pod, one fact counted twice, and no answer to "which
// pod owns this".
//
// The project is the durable scope, so it owns the write. The session pod stays a
// session record and only receives facts when there is no project to own them —
// an agent running outside any repo.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const SESSION = { id: 1, uid: 'pod-session-abc' };
const PROJECT = { id: 2, uid: 'pod-project-xyz' };

let ensureActiveSession;
let ensureProjectPod;
let dispatch;

beforeEach(async () => {
  vi.resetModules();
  ensureActiveSession = vi.fn().mockResolvedValue(SESSION);
  ensureProjectPod = vi.fn().mockResolvedValue(PROJECT);
  vi.doMock('./active-session.js', () => ({ ensureActiveSession }));
  vi.doMock('./kinds/project.js', () => ({ ensureProjectPod }));
  ({ ensureActivePodsForHook: dispatch } = await import('./hook-dispatcher.js'));
});

describe('ensureActivePodsForHook — pod ownership', () => {
  it('attaches to the PROJECT only, not the session, when both exist', async () => {
    const r = await dispatch({ sessionId: 's1', cwd: '/repo/mycohort-api' });
    expect(r.podUids).toEqual([PROJECT.uid]);
    expect(r.podUids).not.toContain(SESSION.uid);
  });

  it('still returns the session pod object — it stays a session record', async () => {
    // Callers (`sigil session show`, transcript/model bookkeeping) need the pod
    // even though it no longer receives the write.
    const r = await dispatch({ sessionId: 's1', cwd: '/repo/mycohort-api' });
    expect(r.sessionPod).toEqual(SESSION);
    expect(r.projectPod).toEqual(PROJECT);
  });

  it('falls back to the session pod when there is no project', async () => {
    // An agent invoked outside any repo: the session is the only real scope.
    ensureProjectPod.mockResolvedValue(null);
    const r = await dispatch({ sessionId: 's1', cwd: '/tmp' });
    expect(r.podUids).toEqual([SESSION.uid]);
  });

  it('attaches to the project even with no session at all', async () => {
    const r = await dispatch({ sessionId: null, cwd: '/repo/mycohort-api' });
    expect(r.podUids).toEqual([PROJECT.uid]);
    expect(ensureActiveSession).not.toHaveBeenCalled();
  });

  it('returns no pod when neither resolves, rather than throwing', async () => {
    // Unattached is a valid outcome — scoped search treats no-pod as globally
    // visible, so the fact is still reachable.
    ensureProjectPod.mockResolvedValue(null);
    ensureActiveSession.mockResolvedValue(null);
    const r = await dispatch({ sessionId: 's1', cwd: '/tmp' });
    expect(r.podUids).toEqual([]);
  });

  it('survives a throwing project resolver by falling back to the session', async () => {
    ensureProjectPod.mockRejectedValue(new Error('git not found'));
    const r = await dispatch({ sessionId: 's1', cwd: '/repo/x' });
    expect(r.podUids).toEqual([SESSION.uid]);
  });
});
