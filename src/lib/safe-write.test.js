// Tests for safeWrite: atomic replace + backup-once + dry-run.
//
// These run fully offline against a temp dir. They lock the two P0 hardening
// guarantees: writes are atomic (no temp litter, content fully replaced) and the
// pre-sigil snapshot (.sigil.bak) is captured exactly once and never clobbered.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
  readdirSync, chmodSync, statSync, lstatSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeWrite } from './safe-write.js';

let DIR;
beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), 'sigil-safewrite-')); });
afterEach(() => { if (DIR) rmSync(DIR, { recursive: true, force: true }); });

describe('safeWrite', () => {
  it('creates a new file and reports create', async () => {
    const p = join(DIR, 'a.json');
    const r = await safeWrite(p, 'hello');
    expect(r.action).toBe('create');
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  it('captures the pre-sigil snapshot exactly once and never clobbers it', async () => {
    const p = join(DIR, 'b.json');
    writeFileSync(p, 'original');

    await safeWrite(p, 'v2');
    expect(readFileSync(p, 'utf8')).toBe('v2');
    expect(readFileSync(`${p}.sigil.bak`, 'utf8')).toBe('original');

    // A second write must NOT refresh the .bak — it stays the pre-sigil snapshot.
    await safeWrite(p, 'v3');
    expect(readFileSync(p, 'utf8')).toBe('v3');
    expect(readFileSync(`${p}.sigil.bak`, 'utf8')).toBe('original');
  });

  it('leaves no temp litter behind on success', async () => {
    const p = join(DIR, 'c.json');
    await safeWrite(p, 'x');
    // Temp name carries a random suffix now — assert NO .sigil.tmp.* survives.
    expect(readdirSync(DIR).some((f) => f.includes('.sigil.tmp.'))).toBe(false);
  });

  it('dry-run writes nothing to disk', async () => {
    const p = join(DIR, 'd.json');
    const r = await safeWrite(p, 'nope', { dryRun: true });
    expect(r.wrote).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  it('preserves the existing file mode (does not relax 0600 → 0644)', async () => {
    const p = join(DIR, 'secret.json');
    writeFileSync(p, 'before');
    chmodSync(p, 0o600);

    await safeWrite(p, 'after');
    expect(readFileSync(p, 'utf8')).toBe('after');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('writes through a symlinked target instead of detaching it', async () => {
    const real = join(DIR, 'real.json');
    const link = join(DIR, 'link.json');
    writeFileSync(real, 'original');
    symlinkSync(real, link);

    await safeWrite(link, 'updated');

    // The link must still be a symlink (not replaced by a regular file)...
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // ...and the real file behind it carries the new content.
    expect(readFileSync(real, 'utf8')).toBe('updated');
  });
});
