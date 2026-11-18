import { describe, it, expect } from 'vitest';

import { nextReleaseVersion } from './release-version.js';

describe('nextReleaseVersion', () => {
  it('releases the base when nothing is out yet', () => {
    expect(nextReleaseVersion('0.21.0', [])).toBe('0.21.0');
  });
  it('releases the base when it is newer than everything released', () => {
    expect(nextReleaseVersion('0.21.0', ['0.18.3', 'v0.15.4'])).toBe('0.21.0');
  });
  it('bumps the patch after the newest release otherwise', () => {
    expect(nextReleaseVersion('0.21.0', ['0.21.0'])).toBe('0.21.1');
    expect(nextReleaseVersion('0.21.0', ['0.21.0', 'v0.21.4', '0.21.2'])).toBe('0.21.5');
  });
  it('ignores junk and pre-release tags', () => {
    expect(nextReleaseVersion('0.21.0', ['', 'nightly', '0.22.0-beta.1'])).toBe('0.21.0');
  });
});
