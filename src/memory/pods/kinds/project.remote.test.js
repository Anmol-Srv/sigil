// Project identity across machines rests entirely on this normaliser. If two
// clones of one repo normalise differently they get two pods and neither
// device sees the other's work — the failure is silent, because both pods look
// perfectly healthy. So the equivalence classes get pinned explicitly.

import { describe, it, expect } from 'vitest';

import { normalizeGitRemote } from './project.js';

describe('normalizeGitRemote — URL shapes that mean the same repo', () => {
  const EXPECTED = 'github.com/anmol-srv/sigil';

  it('collapses every clone URL git accepts for one repo', () => {
    const forms = [
      'git@github.com:Anmol-Srv/sigil.git',
      'git@github.com:Anmol-Srv/sigil',
      'https://github.com/Anmol-Srv/sigil.git',
      'https://github.com/Anmol-Srv/sigil',
      'ssh://git@github.com/Anmol-Srv/sigil.git',
      'https://github.com/Anmol-Srv/sigil/',
      '  git@github.com:Anmol-Srv/sigil.git\n',
    ];
    for (const f of forms) expect(normalizeGitRemote(f)).toBe(EXPECTED);
  });

  it('is case-insensitive, since the forges are', () => {
    expect(normalizeGitRemote('git@GitHub.com:ANMOL-SRV/Sigil.git')).toBe(EXPECTED);
  });

  it('drops an explicit port so ssh:// and https:// agree', () => {
    expect(normalizeGitRemote('ssh://git@github.com:22/Anmol-Srv/sigil.git')).toBe(EXPECTED);
  });
});

describe('normalizeGitRemote — things that must NOT collapse', () => {
  it('keeps different repos apart', () => {
    expect(normalizeGitRemote('git@github.com:anmol-srv/sigil.git'))
      .not.toBe(normalizeGitRemote('git@github.com:anmol-srv/sigil-web.git'));
  });

  it('keeps the same repo name on different hosts apart', () => {
    expect(normalizeGitRemote('git@github.com:acme/api.git'))
      .not.toBe(normalizeGitRemote('git@gitlab.com:acme/api.git'));
  });

  it('keeps different owners apart', () => {
    expect(normalizeGitRemote('git@github.com:alice/api.git'))
      .not.toBe(normalizeGitRemote('git@github.com:bob/api.git'));
  });

  it('preserves nested group paths, which GitLab relies on', () => {
    expect(normalizeGitRemote('git@gitlab.com:acme/backend/api.git')).toBe('gitlab.com/acme/backend/api');
  });
});

describe('normalizeGitRemote — no remote means no shared identity', () => {
  it('returns null rather than a junk key', () => {
    // null makes the caller fall back to the local path, which is the right
    // answer for a repo that exists on one machine only. A truthy junk value
    // would instead merge every remote-less repo into one shared pod.
    for (const bad of ['', '   ', null, undefined, 'not a url', '/local/path']) {
      expect(normalizeGitRemote(bad)).toBeNull();
    }
  });
});
