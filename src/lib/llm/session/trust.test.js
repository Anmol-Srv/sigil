// The folder-trust dialog is the reason enabling managed sessions did nothing:
// a detached worker sat on "❯ 1. Yes, I trust this folder" until it was
// recycled. These pin the write we do instead — and, just as important, the
// cases where we must NOT write.

import { describe, it, expect } from 'vitest';

import { ensureFolderTrusted } from './trust.js';

function fakeIo(initial) {
  const io = {
    path: '/fake/.claude.json',
    written: null,
    renamed: null,
    async readFile() {
      if (initial === undefined) throw new Error('ENOENT');
      return typeof initial === 'string' ? initial : JSON.stringify(initial);
    },
    async writeFile(p, content) { io.written = { p, content }; },
    async rename(from, to) { io.renamed = { from, to }; },
  };
  return io;
}

const parsed = (io) => JSON.parse(io.written.content);

describe('ensureFolderTrusted', () => {
  it('adds the trust record for the one directory it is given', async () => {
    const io = fakeIo({ projects: { '/other': { hasTrustDialogAccepted: true } } });
    expect(await ensureFolderTrusted('/home/u/.sigil', io)).toBe('added');
    expect(parsed(io).projects['/home/u/.sigil']).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('leaves every other project untouched', async () => {
    // Trusting the worker's workspace must never widen trust elsewhere.
    const io = fakeIo({ projects: { '/other': { hasTrustDialogAccepted: false, lastCost: 3 } } });
    await ensureFolderTrusted('/home/u/.sigil', io);
    expect(parsed(io).projects['/other']).toEqual({ hasTrustDialogAccepted: false, lastCost: 3 });
  });

  it('preserves the rest of the file, which is the user\'s whole Claude Code state', async () => {
    const io = fakeIo({ userID: 'abc', tipsHistory: { x: 1 }, projects: {} });
    await ensureFolderTrusted('/home/u/.sigil', io);
    expect(parsed(io).userID).toBe('abc');
    expect(parsed(io).tipsHistory).toEqual({ x: 1 });
  });

  it('merges into an existing entry rather than replacing it', async () => {
    const io = fakeIo({ projects: { '/home/u/.sigil': { lastCost: 9, hasTrustDialogAccepted: false } } });
    await ensureFolderTrusted('/home/u/.sigil', io);
    expect(parsed(io).projects['/home/u/.sigil'].lastCost).toBe(9);
    expect(parsed(io).projects['/home/u/.sigil'].hasTrustDialogAccepted).toBe(true);
  });

  it('does nothing when the folder is already trusted', async () => {
    const io = fakeIo({ projects: { '/home/u/.sigil': { hasTrustDialogAccepted: true } } });
    expect(await ensureFolderTrusted('/home/u/.sigil', io)).toBe('already');
    expect(io.written).toBeNull();
  });

  it('writes through a temp file, so a crash cannot truncate the real one', async () => {
    const io = fakeIo({ projects: {} });
    await ensureFolderTrusted('/home/u/.sigil', io);
    expect(io.written.p).not.toBe(io.path);
    expect(io.renamed).toEqual({ from: io.written.p, to: io.path });
  });

  it('refuses to invent a config that is missing or corrupt', async () => {
    expect(await ensureFolderTrusted('/d', fakeIo(undefined))).toBe('skipped:no-config');
    expect(await ensureFolderTrusted('/d', fakeIo('{not json'))).toBe('skipped:unparseable');
    expect(await ensureFolderTrusted('/d', fakeIo('null'))).toBe('skipped:unparseable');
  });

  it('never throws when the write fails — a failed pre-trust must not stop the daemon', async () => {
    const io = fakeIo({ projects: {} });
    io.writeFile = async () => { throw new Error('EROFS'); };
    expect(await ensureFolderTrusted('/d', io)).toBe('skipped:write-failed');
  });
});
