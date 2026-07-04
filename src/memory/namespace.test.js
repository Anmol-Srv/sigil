// Per-project namespace resolution (P3).
//
// resolveNamespace walks a fixed precedence: explicit --namespace >
// SIGIL_NAMESPACE env > committed `.sigil/namespace` marker at the repo root >
// the install default (config.defaults.namespace). Pure / synchronous, no DB:
// the marker read is best-effort and never throws. We use real temp dirs (no
// git) so deriveProjectRoot falls back to the dir itself and the marker read is
// deterministic.

import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveNamespace, readNamespaceMarker } from './namespace.js';
import config from '../config.js';

// Write `.sigil/namespace` under a fresh temp dir and return the dir.
function makeMarkerDir(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-ns-'));
  mkdirSync(join(dir, '.sigil'), { recursive: true });
  writeFileSync(join(dir, '.sigil', 'namespace'), contents, 'utf8');
  return dir;
}

describe('resolveNamespace', () => {
  let savedEnv;

  beforeEach(() => {
    // Isolate from the ambient env so the env tier is controlled per-test.
    savedEnv = process.env.SIGIL_NAMESPACE;
    delete process.env.SIGIL_NAMESPACE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SIGIL_NAMESPACE;
    else process.env.SIGIL_NAMESPACE = savedEnv;
  });

  it('returns the install default when nothing is set (no marker, no env)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-ns-none-'));
    expect(resolveNamespace({ cwd: dir })).toBe(config.defaults.namespace);
  });

  it('returns the install default when cwd is omitted entirely', () => {
    expect(resolveNamespace()).toBe(config.defaults.namespace);
    expect(resolveNamespace({})).toBe(config.defaults.namespace);
  });

  it('uses the committed .sigil/namespace marker over the default', () => {
    const dir = makeMarkerDir('the-coffee-team');
    expect(resolveNamespace({ cwd: dir })).toBe('the-coffee-team');
  });

  it('trims surrounding whitespace/newlines from the marker', () => {
    const dir = makeMarkerDir('\n  the-coffee-team \n\n');
    expect(resolveNamespace({ cwd: dir })).toBe('the-coffee-team');
    expect(readNamespaceMarker(dir)).toBe('the-coffee-team');
  });

  it('ignores an empty/whitespace-only marker and falls back to the default', () => {
    const dir = makeMarkerDir('   \n  ');
    expect(readNamespaceMarker(dir)).toBeNull();
    expect(resolveNamespace({ cwd: dir })).toBe(config.defaults.namespace);
  });

  it('SIGIL_NAMESPACE env beats the marker', () => {
    const dir = makeMarkerDir('the-coffee-team');
    process.env.SIGIL_NAMESPACE = 'env-team';
    expect(resolveNamespace({ cwd: dir })).toBe('env-team');
  });

  it('SIGIL_NAMESPACE env is trimmed and ignored when blank', () => {
    process.env.SIGIL_NAMESPACE = '  spaced-team  ';
    expect(resolveNamespace({})).toBe('spaced-team');

    process.env.SIGIL_NAMESPACE = '   ';
    expect(resolveNamespace({})).toBe(config.defaults.namespace);
  });

  it('explicit value beats the env', () => {
    process.env.SIGIL_NAMESPACE = 'env-team';
    expect(resolveNamespace({ explicit: 'cli-ns' })).toBe('cli-ns');
  });

  it('explicit value beats the marker', () => {
    const dir = makeMarkerDir('the-coffee-team');
    expect(resolveNamespace({ cwd: dir, explicit: 'cli-ns' })).toBe('cli-ns');
  });

  it('full precedence: explicit > env > marker > default', () => {
    const dir = makeMarkerDir('marker-ns');

    // explicit wins over all
    process.env.SIGIL_NAMESPACE = 'env-ns';
    expect(resolveNamespace({ cwd: dir, explicit: 'explicit-ns' })).toBe('explicit-ns');

    // env wins over marker + default
    expect(resolveNamespace({ cwd: dir })).toBe('env-ns');

    // marker wins over default
    delete process.env.SIGIL_NAMESPACE;
    expect(resolveNamespace({ cwd: dir })).toBe('marker-ns');
  });
});

describe('readNamespaceMarker', () => {
  it('returns null for a missing marker (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-ns-missing-'));
    expect(readNamespaceMarker(dir)).toBeNull();
  });

  it('returns null when given no path', () => {
    expect(readNamespaceMarker(null)).toBeNull();
    expect(readNamespaceMarker(undefined)).toBeNull();
  });
});
