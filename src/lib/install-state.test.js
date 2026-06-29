// Tests for the S2 install-integrity diff — the detector for the silent
// version/path skew behind the dueling-install corruption. Pure logic + the
// shim-parsing IO (against a temp file).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diffInstallState, readShimDist } from './install-state.js';

const CANON = { dir: '/home/u/.sigil/app', dist: '/home/u/.sigil/app/dist', exists: true, version: '0.20.0' };

describe('diffInstallState', () => {
  it('is not applicable when there is no canonical git install (dev/source run)', () => {
    const r = diffInstallState({ canonical: { ...CANON, exists: false } });
    expect(r.applicable).toBe(false);
  });

  it('is ok when shims + daemon all align with the git install', () => {
    const r = diffInstallState({
      canonical: CANON,
      shimDist: '/home/u/.sigil/app/dist',
      heartbeat: { version: '0.20.0', root: '/home/u/.sigil/app', pid: 42 },
    });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('tolerates a trailing slash on the shim dist', () => {
    const r = diffInstallState({ canonical: CANON, shimDist: '/home/u/.sigil/app/dist/' });
    expect(r.issues.find((i) => i.code === 'shim-mismatch')).toBeUndefined();
  });

  it('flags shims pointing at a different install (the npm-global incident)', () => {
    const r = diffInstallState({
      canonical: CANON,
      shimDist: '/usr/local/lib/node_modules/@anmol-srv/sigil/dist',
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('shim-mismatch');
  });

  it('flags a daemon running a stale version', () => {
    const r = diffInstallState({
      canonical: CANON,
      shimDist: CANON.dist,
      heartbeat: { version: '0.18.3', root: CANON.dir, pid: 99 },
    });
    expect(r.issues.map((i) => i.code)).toContain('daemon-stale');
  });

  it('flags a daemon serving from a foreign root', () => {
    const r = diffInstallState({
      canonical: CANON,
      shimDist: CANON.dist,
      heartbeat: { version: '0.20.0', root: '/usr/local/lib/node_modules/@anmol-srv/sigil', pid: 7 },
    });
    expect(r.issues.map((i) => i.code)).toContain('daemon-foreign-root');
  });

  it('does not flag version/root when no daemon is running', () => {
    const r = diffInstallState({ canonical: CANON, shimDist: CANON.dist, heartbeat: null });
    expect(r.ok).toBe(true);
  });
});

describe('readShimDist', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sigil-shim-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts SIGIL_DIST from a generated launcher shim', () => {
    const shim = join(dir, 'sigil');
    writeFileSync(shim, "#!/bin/sh\nSIGIL_DIST='/home/u/.sigil/app/dist'\nSIGIL_NODE='/usr/bin/node'\nexec \"$SIGIL_NODE\" \"$SIGIL_DIST/cli.js\" \"$@\"\n");
    expect(readShimDist(shim)).toBe('/home/u/.sigil/app/dist');
  });

  it('returns null for a missing shim', () => {
    expect(readShimDist(join(dir, 'nope'))).toBeNull();
  });
});
