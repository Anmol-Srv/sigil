// Tests for the hook circuit breaker (F5) — the short cooldown that stops a
// burst of hooks from hammering an alive-but-wedged daemon (the CPU storm).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { breakerOpen, tripBreaker, resetBreaker, BREAKER_COOLDOWN_MS } from './daemon-breaker.js';

describe('daemon breaker', () => {
  let dir;
  let path;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigil-breaker-'));
    path = join(dir, '.daemon-breaker.json');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is closed when no breaker file exists', () => {
    expect(breakerOpen(Date.now(), path)).toBe(false);
  });

  it('is open after a trip, within the cooldown window', () => {
    const now = 1_000_000;
    tripBreaker(now, path);
    expect(breakerOpen(now, path)).toBe(true);
    expect(breakerOpen(now + BREAKER_COOLDOWN_MS - 1, path)).toBe(true);
  });

  it('closes once the cooldown elapses', () => {
    const now = 1_000_000;
    tripBreaker(now, path);
    expect(breakerOpen(now + BREAKER_COOLDOWN_MS, path)).toBe(false);
    expect(breakerOpen(now + BREAKER_COOLDOWN_MS + 5_000, path)).toBe(false);
  });

  it('reset closes it immediately and removes the file', () => {
    const now = 1_000_000;
    tripBreaker(now, path);
    expect(existsSync(path)).toBe(true);
    resetBreaker(path);
    expect(breakerOpen(now, path)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('treats a corrupt breaker file as closed (fail-safe)', () => {
    // breakerOpen must never throw — a garbled file should just mean "probe".
    writeFileSync(path, 'not json{');
    expect(breakerOpen(Date.now(), path)).toBe(false);
  });
});
