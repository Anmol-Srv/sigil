import { describe, it, expect } from 'vitest';

import { serviceUnitIsStale } from './index.js';

const APP_DAEMON = '/Users/u/.sigil/app/dist/daemon.js';

describe('serviceUnitIsStale', () => {
  it('is false when the unit runs this install', () => {
    const plist = `<array><string>/usr/bin/node</string><string>${APP_DAEMON}</string></array>`;
    expect(serviceUnitIsStale(plist, APP_DAEMON)).toBe(false);
    expect(serviceUnitIsStale(`ExecStart=/usr/bin/node ${APP_DAEMON}\n`, APP_DAEMON)).toBe(false);
  });
  it('is true when the unit still runs a legacy npm copy', () => {
    const plist = '<string>/usr/local/lib/node_modules/@anmol-srv/sigil/dist/daemon.js</string>';
    expect(serviceUnitIsStale(plist, APP_DAEMON)).toBe(true);
  });
  it('is true for an empty or unreadable unit', () => {
    expect(serviceUnitIsStale('', APP_DAEMON)).toBe(true);
    expect(serviceUnitIsStale(null, APP_DAEMON)).toBe(true);
  });
});
