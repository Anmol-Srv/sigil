// Project-root derivation (Lane C support).
//
// deriveProjectRoot is the basis of project-pod scoping: a git repo resolves
// to its toplevel, a non-git directory resolves to itself (never throws, never
// returns empty — a silent [] here is what collapsed search to global). Pure /
// synchronous, so this needs no DB or mocks.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { deriveProjectRoot } from './kinds/project.js';

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
