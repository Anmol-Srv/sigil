import { describe, expect, it } from 'vitest';

import { binInstalled } from './detect.js';

describe('binInstalled', () => {
  it('recognises a client executable available through an absolute PATH directory', () => {
    // Node itself is guaranteed to exist in its active executable directory;
    // this covers version-managed install paths without depending on nvm/fnm.
    const previous = process.env.PATH;
    process.env.PATH = `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/not-a-real-bin`;
    try {
      expect(binInstalled([process.execPath.slice(process.execPath.lastIndexOf('/') + 1)])).toBe(true);
    } finally {
      process.env.PATH = previous;
    }
  });
});
