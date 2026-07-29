import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearProjectScopeCache,
  normalizeGitRemote,
  resolveProjectScope,
} from './project-scope.js';

beforeEach(() => clearProjectScopeCache());

function gitFor({ root = '/work/app', remote = 'git@github.com:acme/app.git' } = {}) {
  return (_cwd, args) => {
    if (args[0] === 'rev-parse') return root;
    if (args[0] === 'remote') return remote;
    return '';
  };
}

describe('project memory scope', () => {
  it('uses one stable namespace for clones of the same Git origin', () => {
    const first = resolveProjectScope({
      cwd: '/work/first', runGit: gitFor({ root: '/work/first' }), resolvePath: (p) => p,
    });
    const second = resolveProjectScope({
      cwd: '/work/second', runGit: gitFor({ root: '/work/second' }), resolvePath: (p) => p,
    });

    expect(first).toMatchObject({ kind: 'project', source: 'git-origin' });
    expect(second.projectNamespace).toBe(first.projectNamespace);
  });

  it('keeps unrelated repositories separate', () => {
    const first = resolveProjectScope({ runGit: gitFor({ remote: 'https://github.com/acme/one.git' }) });
    const second = resolveProjectScope({
      cwd: '/work/two', runGit: gitFor({ root: '/work/two', remote: 'https://github.com/acme/two.git' }), resolvePath: (p) => p,
    });

    expect(second.projectNamespace).not.toBe(first.projectNamespace);
  });

  it('falls back to shared memory outside Git and honours an explicit opt-out', () => {
    const outside = resolveProjectScope({ runGit: () => '' });
    const optedOut = resolveProjectScope({
      env: { SIGIL_SCOPE: 'shared' },
      runGit: () => { throw new Error('git must not run for an opt-out'); },
    });

    expect(outside).toMatchObject({ kind: 'shared', source: 'no-git' });
    expect(optedOut).toMatchObject({ kind: 'shared', source: 'explicit-shared' });
  });

  it('can isolate a worktree deliberately', () => {
    const sharedProject = resolveProjectScope({
      cwd: '/work/app-a', runGit: gitFor({ root: '/work/app-a' }), resolvePath: (p) => p,
    });
    const isolated = resolveProjectScope({
      cwd: '/work/app-b',
      env: { SIGIL_SCOPE: 'worktree' },
      runGit: gitFor({ root: '/work/app-b' }),
      resolvePath: (p) => p,
    });

    expect(isolated.projectNamespace).not.toBe(sharedProject.projectNamespace);
    expect(isolated.source).toBe('git-path');
  });

  it('normalizes the common clone URL forms to one identity', () => {
    const expected = 'github.com/acme/sigil';
    expect(normalizeGitRemote('git@github.com:Acme/Sigil.git')).toBe(expected);
    expect(normalizeGitRemote('ssh://git@github.com/acme/sigil.git')).toBe(expected);
    expect(normalizeGitRemote('https://token@github.com/acme/sigil.git?tab=readme')).toBe(expected);
  });
});
