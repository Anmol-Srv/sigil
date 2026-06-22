// Holder + init guards. The disabled path is the common one (managed sessions
// are opt-in) and must short-circuit with zero side effects — no tmux probe, no
// worker spawn — so non-daemon callers and default installs transparently use
// the one-shot path.

import { describe, it, expect, afterEach } from 'vitest';

import { getSessionManager, setSessionManager, initSessionManager } from './index.js';

afterEach(() => setSessionManager(null));

describe('session holder', () => {
  it('round-trips the current manager and clears to null', () => {
    expect(getSessionManager()).toBeNull();
    const fake = { id: 'fake' };
    setSessionManager(fake);
    expect(getSessionManager()).toBe(fake);
    setSessionManager(null);
    expect(getSessionManager()).toBeNull();
  });
});

describe('initSessionManager', () => {
  it('returns null and registers nothing when disabled', async () => {
    const logs = [];
    const mgr = await initSessionManager({
      config: { llm: { managedSession: { enabled: false } } },
      log: (m) => logs.push(m),
    });
    expect(mgr).toBeNull();
    expect(getSessionManager()).toBeNull();
    expect(logs.join(' ')).toMatch(/disabled/);
  });

  it('returns null when managedSession config is absent entirely', async () => {
    const mgr = await initSessionManager({ config: { llm: {} }, log: () => {} });
    expect(mgr).toBeNull();
  });
});
