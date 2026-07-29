import { describe, expect, it } from 'vitest';
import { detectInstalled } from './detect.js';

describe('client auto-detection', () => {
  it('does not treat a stale or Sigil-created config directory as an installed client', () => {
    const detected = detectInstalled(
      { dirs: ['/Users/example/.cursor'], apps: ['Cursor'], bins: ['cursor'] },
      { checkApp: () => false, checkBin: () => false },
    );

    expect(detected).toBe(false);
  });

  it('recognizes a real app bundle or executable', () => {
    expect(detectInstalled(
      { apps: ['Cursor'], bins: ['cursor'] },
      { checkApp: () => true, checkBin: () => false },
    )).toBe(true);
    expect(detectInstalled(
      { apps: ['Cursor'], bins: ['cursor'] },
      { checkApp: () => false, checkBin: () => true },
    )).toBe(true);
  });
});
