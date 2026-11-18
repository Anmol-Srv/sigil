import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { compareVersions, isLegacyNpmVersion, isDoorRoot, planDoor } from './npm-door.js';

const APP = join('/home/u', '.sigil', 'app');

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.21.10', '0.21.9')).toBe(1);
    expect(compareVersions('0.9.0', '0.21.0')).toBe(-1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });
  it('ignores pre-release suffixes and missing parts', () => {
    expect(compareVersions('0.21.0-beta.1', '0.21.0')).toBe(0);
    expect(compareVersions('0.21', '0.21.0')).toBe(0);
    expect(compareVersions(null, '0.0.1')).toBe(-1);
  });
});

describe('isLegacyNpmVersion', () => {
  it('treats pre-door releases as legacy', () => {
    expect(isLegacyNpmVersion('0.18.3')).toBe(true);
    expect(isLegacyNpmVersion('0.21.0')).toBe(true);  // git-only release, never on npm
    expect(isLegacyNpmVersion('0.22.0')).toBe(false);
    expect(isLegacyNpmVersion('1.0.0')).toBe(false);
  });
});

describe('isDoorRoot', () => {
  it('is true for npm global, npx and pnpm locations', () => {
    expect(isDoorRoot('/usr/local/lib/node_modules/@anmol-srv/sigil', APP)).toBe(true);
    expect(isDoorRoot('/home/u/.npm/_npx/abc/node_modules/@anmol-srv/sigil', APP)).toBe(true);
    expect(isDoorRoot('/home/u/.local/share/pnpm/global/5/node_modules/@anmol-srv/sigil', APP)).toBe(true);
  });
  it('is false for the git install and a source checkout', () => {
    expect(isDoorRoot(APP, APP)).toBe(false);
    expect(isDoorRoot(APP + '/', APP)).toBe(false);
    expect(isDoorRoot('/home/u/code/sigil', APP)).toBe(false);
  });
});

describe('planDoor', () => {
  it('installs fresh when nothing is installed', () => {
    expect(planDoor({ doorVersion: '0.21.0', appInstalled: false, hasDatabase: false }))
      .toEqual({ install: true, finish: false, reason: 'fresh' });
  });
  it('moves a legacy npm user onto the git install and migrates their data', () => {
    expect(planDoor({ doorVersion: '0.21.0', appInstalled: false, hasDatabase: true }))
      .toEqual({ install: true, finish: true, reason: 'migrate-legacy' });
  });
  it('updates an older git install', () => {
    expect(planDoor({ doorVersion: '0.21.2', appInstalled: true, appVersion: '0.21.1', hasDatabase: true }))
      .toEqual({ install: true, finish: true, reason: 'update' });
    // Setup never finished: nothing to restart or migrate.
    expect(planDoor({ doorVersion: '0.21.2', appInstalled: true, appVersion: '0.21.1', hasDatabase: false }).finish)
      .toBe(false);
  });
  it('tries a catch-up only once per npm version', () => {
    expect(planDoor({ doorVersion: '0.22.1', appInstalled: true, appVersion: '0.22.0', hasDatabase: true, attempted: true }))
      .toEqual({ install: false, finish: false, reason: 'catch-up-tried' });
  });
  it('hands straight off when the install is current or newer', () => {
    expect(planDoor({ doorVersion: '0.21.2', appInstalled: true, appVersion: '0.21.2' }).install).toBe(false);
    expect(planDoor({ doorVersion: '0.21.2', appInstalled: true, appVersion: '0.22.0' }).install).toBe(false);
  });
});
