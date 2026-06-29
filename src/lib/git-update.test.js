// Tests for evictLegacyNpmInstall (S3) — removing a leftover global npm install
// so the git install is the sole owner of the single-process embedded DB. The
// `npm` runner is injected; the global root is a real temp dir so the
// existsSync / self-guard branches exercise real filesystem logic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evictLegacyNpmInstall } from './git-update.js';

let globalRoot;
afterEach(() => { if (globalRoot) rmSync(globalRoot, { recursive: true, force: true }); });
beforeEach(() => { globalRoot = mkdtempSync(join(tmpdir(), 'sigil-npmroot-')); });

/** An injected npm that reports our temp dir as the global root. */
function fakeNpm(calls) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'root' && args[1] === '-g') return Promise.resolve({ stdout: globalRoot + '\n' });
    if (args[0] === 'rm') return Promise.resolve({ stdout: '' });
    return Promise.reject(new Error(`unexpected npm ${args.join(' ')}`));
  };
}

describe('evictLegacyNpmInstall', () => {
  it('removes the global package when it is present', async () => {
    mkdirSync(join(globalRoot, '@anmol-srv', 'sigil'), { recursive: true });
    const calls = [];

    const r = await evictLegacyNpmInstall({ npm: fakeNpm(calls) });

    expect(r.evicted).toBe(true);
    expect(calls).toContainEqual(['rm', '-g', '@anmol-srv/sigil']);
  });

  it('is a no-op when no global install exists', async () => {
    const calls = [];
    const r = await evictLegacyNpmInstall({ npm: fakeNpm(calls) });

    expect(r).toEqual({ evicted: false, reason: 'not-installed' });
    expect(calls).not.toContainEqual(['rm', '-g', '@anmol-srv/sigil']); // never removed
  });

  it('reports npm-unavailable instead of throwing when npm is missing', async () => {
    const r = await evictLegacyNpmInstall({ npm: () => Promise.reject(new Error('ENOENT')) });
    expect(r).toEqual({ evicted: false, reason: 'npm-unavailable' });
  });

  it('surfaces a removal failure without throwing', async () => {
    mkdirSync(join(globalRoot, '@anmol-srv', 'sigil'), { recursive: true });
    const npm = (args) => args[0] === 'root'
      ? Promise.resolve({ stdout: globalRoot })
      : Promise.reject(new Error('EACCES: permission denied'));

    const r = await evictLegacyNpmInstall({ npm });
    expect(r).toEqual({ evicted: false, reason: 'rm-failed' });
  });
});
