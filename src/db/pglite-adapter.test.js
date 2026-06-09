// Tests for isPgliteAbort — the detector that decides when a PGlite WASM heap is
// poisoned (field-report Defect 3 / F4) and must be recycled rather than retried.

import { describe, it, expect, afterEach } from 'vitest';

import { isPgliteAbort, pgliteDebugLevel } from './pglite-adapter.js';

describe('isPgliteAbort', () => {
  it('detects the bare Aborted() message PGlite surfaces', () => {
    expect(isPgliteAbort(new Error('Aborted(). Build with -sASSERTIONS for more info.'))).toBe(true);
  });

  it('detects a WebAssembly.RuntimeError', () => {
    expect(isPgliteAbort(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(true);
  });

  it('detects an error whose name is RuntimeError', () => {
    const e = new Error('out of bounds');
    e.name = 'RuntimeError';
    expect(isPgliteAbort(e)).toBe(true);
  });

  it('is false for ordinary query errors (so we never recycle on a normal failure)', () => {
    expect(isPgliteAbort(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(isPgliteAbort(new Error('relation "fact" does not exist'))).toBe(false);
    expect(isPgliteAbort(null)).toBe(false);
    expect(isPgliteAbort(undefined)).toBe(false);
  });
});

describe('pgliteDebugLevel (F7 — SIGIL_PGLITE_DEBUG)', () => {
  const saved = process.env.SIGIL_PGLITE_DEBUG;
  afterEach(() => {
    if (saved === undefined) delete process.env.SIGIL_PGLITE_DEBUG;
    else process.env.SIGIL_PGLITE_DEBUG = saved;
  });

  it('is undefined when unset (normal runs stay quiet)', () => {
    delete process.env.SIGIL_PGLITE_DEBUG;
    expect(pgliteDebugLevel()).toBeUndefined();
  });

  it('maps "1"/"true" to level 1', () => {
    process.env.SIGIL_PGLITE_DEBUG = '1';
    expect(pgliteDebugLevel()).toBe(1);
    process.env.SIGIL_PGLITE_DEBUG = 'true';
    expect(pgliteDebugLevel()).toBe(1);
  });

  it('accepts explicit levels 1..5 and rejects out-of-range / garbage', () => {
    process.env.SIGIL_PGLITE_DEBUG = '5';
    expect(pgliteDebugLevel()).toBe(5);
    process.env.SIGIL_PGLITE_DEBUG = '9';
    expect(pgliteDebugLevel()).toBeUndefined();
    process.env.SIGIL_PGLITE_DEBUG = 'yes';
    expect(pgliteDebugLevel()).toBeUndefined();
  });
});
