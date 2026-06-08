// Tests for isPgliteAbort — the detector that decides when a PGlite WASM heap is
// poisoned (field-report Defect 3 / F4) and must be recycled rather than retried.

import { describe, it, expect } from 'vitest';

import { isPgliteAbort } from './pglite-adapter.js';

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
