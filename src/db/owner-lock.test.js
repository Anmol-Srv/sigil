// Tests for the S4 DB-owner lock decision + path derivation — the structural
// guard that stops two installs from opening the single-process embedded DB.

import { describe, it, expect } from 'vitest';

import { ownerLockDecision, ownerLockPath } from './pglite-adapter.js';

const SELF = 1000;
const dead = () => false;
const alive = () => true;

describe('ownerLockDecision', () => {
  it('creates when there is no existing lock', () => {
    expect(ownerLockDecision(null, { selfPid: SELF, isAlive: dead })).toBe('create');
  });

  it('creates over a garbage/pidless lock record', () => {
    expect(ownerLockDecision({ root: '/x' }, { selfPid: SELF, isAlive: alive })).toBe('create');
  });

  it('reports held when the lock is already ours', () => {
    expect(ownerLockDecision({ pid: SELF }, { selfPid: SELF, isAlive: alive })).toBe('held');
  });

  it('reclaims a lock from a dead process', () => {
    expect(ownerLockDecision({ pid: 2000 }, { selfPid: SELF, isAlive: dead })).toBe('reclaim');
  });

  it('refuses a lock held by a live different process (the dueling-install guard)', () => {
    expect(ownerLockDecision({ pid: 2000 }, { selfPid: SELF, isAlive: alive })).toBe('refuse');
  });
});

describe('ownerLockPath', () => {
  it('is a sibling of the data dir (outside it, so dump/restore never touch it)', () => {
    expect(ownerLockPath('/home/u/.sigil/db')).toBe('/home/u/.sigil/db.owner.lock');
  });

  it('ignores a trailing slash on the data dir', () => {
    expect(ownerLockPath('/home/u/.sigil/db/')).toBe('/home/u/.sigil/db.owner.lock');
  });
});
