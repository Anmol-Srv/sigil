// Re-key legacy path-keyed project pods (P1b). The path-classifier and the
// per-pod planner are exercised here without a real DB: planPod takes an
// injectable `db` whose only call is a single collision lookup, which we stub.
// The remote re-derivation (deriveProjectIdentity) is driven through a real
// temp git repo so the remote→identity path is covered end to end, plus the
// "path gone / no remote" skip branch via a bare temp dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { isPathKeyed, planPod } from './rekey.js';

describe('isPathKeyed', () => {
  it('treats absolute POSIX paths as legacy path keys', () => {
    expect(isPathKeyed('/Users/x/repos/sigil')).toBe(true);
    expect(isPathKeyed('/tmp/foo')).toBe(true);
  });
  it('treats Windows drive paths as legacy path keys', () => {
    expect(isPathKeyed('C:\\Users\\x\\repo')).toBe(true);
    expect(isPathKeyed('D:/work/repo')).toBe(true);
  });
  it('treats remote identities as NOT path-keyed', () => {
    expect(isPathKeyed('github.com/owner/repo')).toBe(false);
    expect(isPathKeyed('gitlab.com/group/sub/repo')).toBe(false);
  });
  it('handles empty / non-string input', () => {
    expect(isPathKeyed('')).toBe(false);
    expect(isPathKeyed(null)).toBe(false);
    expect(isPathKeyed(undefined)).toBe(false);
  });
});

// A db stub whose `db('pod').where(...).whereNot(...).first()` resolves to a
// preset collision target (or null). Only planPod's lookup chain is used.
function stubDb(collisionTarget) {
  const chain = {
    where() { return chain; },
    whereNot() { return chain; },
    async first() { return collisionTarget; },
  };
  return () => chain;
}

describe('planPod', () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sigil-rekey-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:ggondim/api-ffmpeg.git'], { cwd: repo });
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('skips a pod that is already remote-keyed', async () => {
    const pod = { id: 1, externalId: 'github.com/ggondim/api-ffmpeg', namespace: 'default', attrs: {} };
    const plan = await planPod(pod, { db: stubDb(null) });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toMatch(/already remote/);
  });

  it('plans a REKEY when the repo has a remote and no remote-keyed pod exists', async () => {
    const pod = { id: 1, externalId: repo, namespace: 'default', attrs: { git_root: repo } };
    const plan = await planPod(pod, { db: stubDb(null) });
    expect(plan.action).toBe('rekey');
    expect(plan.newExternalId).toBe('github.com/ggondim/api-ffmpeg');
  });

  it('plans a MERGE when a remote-keyed pod already holds the identity', async () => {
    const pod = { id: 1, externalId: repo, namespace: 'default', attrs: { git_root: repo } };
    const target = { id: 2, uid: 'pod-target', externalId: 'github.com/ggondim/api-ffmpeg' };
    const plan = await planPod(pod, { db: stubDb(target) });
    expect(plan.action).toBe('merge');
    expect(plan.target).toBe(target);
    expect(plan.newExternalId).toBe('github.com/ggondim/api-ffmpeg');
  });

  it('skips a legacy pod whose path is gone / has no git remote', async () => {
    const gone = join(tmpdir(), 'sigil-rekey-gone-does-not-exist-xyz');
    const pod = { id: 1, externalId: gone, namespace: 'default', attrs: { git_root: gone } };
    const plan = await planPod(pod, { db: stubDb(null) });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toMatch(/no git remote/);
  });
});
