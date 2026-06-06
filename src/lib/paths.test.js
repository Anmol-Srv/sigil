import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ephemeralPackageRoot } from './paths.js';

describe('ephemeralPackageRoot', () => {
  it('flags a pnpm dlx cache path', () => {
    const r = ephemeralPackageRoot('/Users/x/Library/Caches/pnpm/dlx/abc123/node_modules/@anmol-srv/sigil');
    expect(r.ephemeral).toBe(true);
    expect(r.kind).toBe('pnpm-dlx');
    // Migrated to bash-script-only: every ephemeral refusal points at install.sh.
    expect(r.installHint).toContain('install.sh');
  });

  it('flags an npx (_npx) cache path', () => {
    const r = ephemeralPackageRoot('/Users/x/.npm/_npx/deadbeef/node_modules/@anmol-srv/sigil');
    expect(r.ephemeral).toBe(true);
    expect(r.kind).toBe('npx');
    expect(r.installHint).toContain('install.sh');
  });

  it('flags anything under the OS temp dir', () => {
    const r = ephemeralPackageRoot(join(tmpdir(), 'xfs-1234', 'node_modules', '@anmol-srv', 'sigil'));
    expect(r.ephemeral).toBe(true);
    expect(r.kind).toBe('temp');
  });

  it('does NOT flag a persistent pnpm global install', () => {
    expect(ephemeralPackageRoot('/Users/x/Library/pnpm/global/5/node_modules/@anmol-srv/sigil').ephemeral).toBe(false);
  });

  it('does NOT flag a persistent npm -g install', () => {
    expect(ephemeralPackageRoot('/usr/local/lib/node_modules/@anmol-srv/sigil').ephemeral).toBe(false);
  });

  it('does NOT flag a local source checkout', () => {
    expect(ephemeralPackageRoot('/Users/x/Drive/Projects/sigil').ephemeral).toBe(false);
  });

  it('defaults to the live PKG_ROOT (this repo checkout) — not ephemeral', () => {
    expect(ephemeralPackageRoot().ephemeral).toBe(false);
  });
});
