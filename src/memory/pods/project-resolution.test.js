// Project-root derivation + project IDENTITY derivation (Lane C / P1).
//
// deriveProjectRoot is the basis of project-pod path attrs: a git repo resolves
// to its toplevel, a non-git directory resolves to itself (never throws, never
// returns empty — a silent [] here is what collapsed search to global).
// deriveProjectIdentity is the pod externalId, decoupled from the path so two
// clones at different paths share one pod (env → remote → marker → path). All
// pure / synchronous, so this needs no DB or mocks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { deriveProjectRoot, deriveProjectIdentity, normalizeGitRemote } from './kinds/project.js';
import { __setTestConfig, __resetTestConfig } from '../../setup/config-store.js';

describe('deriveProjectRoot', () => {
  it('returns the git toplevel when inside a repo', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const root = deriveProjectRoot(process.cwd());
    expect(root).toBe(repoRoot);
  });

  it('falls back to the directory itself when there is no git repo', () => {
    // realpath the tmp dir: macOS /var → /private/var, which is what git/cwd
    // would also report, but here there is no git so we just compare to the
    // resolved path the function is given.
    const dir = mkdtempSync(join(tmpdir(), 'sigil-noproj-'));
    const root = deriveProjectRoot(dir);
    expect(root).toBe(dir);
  });
});

describe('normalizeGitRemote', () => {
  const cases = [
    ['https://github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://github.com/owner/repo', 'github.com/owner/repo'],
    ['git@github.com:owner/repo.git', 'github.com/owner/repo'],
    ['git@github.com:owner/repo', 'github.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['git://github.com/owner/repo.git', 'github.com/owner/repo'],
    // uppercase host + path collapse to lowercase
    ['https://GitHub.com/Owner/Repo.git', 'github.com/owner/repo'],
    // credentials in the URL are stripped
    ['https://user:pass@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://token@gitlab.com/group/sub/repo.git', 'gitlab.com/group/sub/repo'],
    // ssh with explicit port
    ['ssh://git@github.com:22/owner/repo.git', 'github.com/owner/repo'],
    // self-hosted nested path, scp form
    ['git@git.example.com:team/area/repo.git', 'git.example.com/team/area/repo'],
    // the proposal's canonical example
    ['git@github.com:3gr4m/the-coffee.git', 'github.com/3gr4m/the-coffee'],
  ];
  it.each(cases)('normalizes %s → %s', (input, expected) => {
    expect(normalizeGitRemote(input)).toBe(expected);
  });

  it('returns null for empty / unparseable input', () => {
    expect(normalizeGitRemote('')).toBeNull();
    expect(normalizeGitRemote('   ')).toBeNull();
    expect(normalizeGitRemote(null)).toBeNull();
    expect(normalizeGitRemote(undefined)).toBeNull();
    // no path component — not a usable repo identity
    expect(normalizeGitRemote('https://github.com')).toBeNull();
  });
});

describe('deriveProjectIdentity', () => {
  // Tests run from non-git temp dirs so detectGitRemote yields null and we can
  // exercise the marker / path / env branches deterministically.
  const saved = {};
  beforeEach(() => {
    saved.id = process.env.SIGIL_PROJECT_ID;
    delete process.env.SIGIL_PROJECT_ID;
    // Strategy is config (SSOT), not env: pin the default before each case.
    __setTestConfig({ project: { identity: 'remote' } });
  });
  afterEach(() => {
    if (saved.id === undefined) delete process.env.SIGIL_PROJECT_ID;
    else process.env.SIGIL_PROJECT_ID = saved.id;
    __resetTestConfig();
  });

  it('SIGIL_PROJECT_ID overrides everything', () => {
    process.env.SIGIL_PROJECT_ID = 'the-coffee';
    const dir = mkdtempSync(join(tmpdir(), 'sigil-id-'));
    expect(deriveProjectIdentity(dir)).toBe('the-coffee');
  });

  it('SIGIL_PROJECT_ID wins even under the path strategy', () => {
    __setTestConfig({ project: { identity: 'path' } });
    process.env.SIGIL_PROJECT_ID = 'forced-id';
    const dir = mkdtempSync(join(tmpdir(), 'sigil-id2-'));
    expect(deriveProjectIdentity(dir)).toBe('forced-id');
  });

  it('falls back to .sigil/project.json marker when there is no remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-marker-'));
    mkdirSync(join(dir, '.sigil'));
    writeFileSync(join(dir, '.sigil', 'project.json'), JSON.stringify({ id: 'marker-id' }));
    expect(deriveProjectIdentity(dir)).toBe('marker-id');
  });

  it('falls back to the absolute path when there is no remote and no marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-path-'));
    expect(deriveProjectIdentity(dir)).toBe(dir);
  });

  it('path strategy uses the absolute path even when a marker exists', () => {
    __setTestConfig({ project: { identity: 'path' } });
    const dir = mkdtempSync(join(tmpdir(), 'sigil-pathstrat-'));
    mkdirSync(join(dir, '.sigil'));
    writeFileSync(join(dir, '.sigil', 'project.json'), JSON.stringify({ id: 'marker-id' }));
    expect(deriveProjectIdentity(dir)).toBe(dir);
  });
});
