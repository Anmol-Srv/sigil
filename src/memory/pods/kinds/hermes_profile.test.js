import { describe, it, expect, vi } from 'vitest';

import { deriveProfileName } from './hermes_profile.js';

describe('deriveProfileName', () => {
  const noActive = () => null;

  it('reads the profile out of a Hermes profile home', () => {
    expect(deriveProfileName('/Users/a/.hermes/profiles/xero', { readActive: noActive })).toBe('xero');
    expect(deriveProfileName('/Users/a/.hermes/profiles/igris', { readActive: noActive })).toBe('igris');
  });

  it('tolerates a trailing slash', () => {
    expect(deriveProfileName('/Users/a/.hermes/profiles/iron/', { readActive: noActive })).toBe('iron');
  });

  it('falls back to the active profile for a bare hermes home', () => {
    // The default profile does not live under profiles/ — Hermes records which
    // one is live in ~/.hermes/active_profile.
    const readActive = vi.fn(() => 'igris');
    expect(deriveProfileName('/Users/a/.hermes', { readActive })).toBe('igris');
    expect(readActive).toHaveBeenCalled();
  });

  it('falls back to the active profile when the kwarg is missing entirely', () => {
    // hermes_home is optional in the plugin contract, and older Hermes builds
    // may not pass it at all.
    expect(deriveProfileName('', { readActive: () => 'xero' })).toBe('xero');
    expect(deriveProfileName(null, { readActive: () => 'xero' })).toBe('xero');
    expect(deriveProfileName(undefined, { readActive: () => 'xero' })).toBe('xero');
  });

  it('lands on "default" when there is no profile and no active_profile file', () => {
    expect(deriveProfileName('/Users/a/.hermes', { readActive: noActive })).toBe('default');
    expect(deriveProfileName('', { readActive: noActive })).toBe('default');
  });

  it('works for a relocated HERMES_HOME, not just ~/.hermes', () => {
    // The rule is "parent dir is named profiles", not "path starts with
    // ~/.hermes" — HERMES_HOME is configurable and hardcoding the home would
    // silently mis-scope every profile under it.
    expect(deriveProfileName('/opt/hermes/profiles/xero', { readActive: noActive })).toBe('xero');
  });

  it('does not mistake a directory merely named like a profile', () => {
    // ~/.hermes/cache is not a profile — only children of profiles/ are.
    expect(deriveProfileName('/Users/a/.hermes/cache', { readActive: () => 'igris' })).toBe('igris');
  });
});

describe('ensureHermesProfilePod', () => {
  it('returns the pod ROW, not upsertPod\'s { pod, isNew } wrapper', async () => {
    // The wrapper is why the first cut attached nothing: `.uid` came back
    // undefined and every downstream attach was skipped in silence.
    vi.resetModules();
    const upsertPod = vi.fn().mockResolvedValue({ pod: { id: 7, uid: 'pod-abc', name: 'hermes:xero' }, isNew: true });
    vi.doMock('../store.js', () => ({ upsertPod }));
    vi.doMock('../../../config.js', () => ({ default: { defaults: { namespace: 'default' } } }));

    const { ensureHermesProfilePod } = await import('./hermes_profile.js');
    const pod = await ensureHermesProfilePod({ profile: 'xero', hermesHome: '/h/profiles/xero' });

    expect(pod.uid).toBe('pod-abc');
    expect(upsertPod).toHaveBeenCalledWith(expect.objectContaining({
      podType: 'hermes_profile',
      externalId: 'xero',
      name: 'hermes:xero',
    }));
  });

  it('returns null for a blank profile rather than minting a junk pod', async () => {
    vi.resetModules();
    const upsertPod = vi.fn();
    vi.doMock('../store.js', () => ({ upsertPod }));
    vi.doMock('../../../config.js', () => ({ default: { defaults: { namespace: 'default' } } }));

    const { ensureHermesProfilePod } = await import('./hermes_profile.js');
    expect(await ensureHermesProfilePod({ profile: '  ' })).toBeNull();
    expect(upsertPod).not.toHaveBeenCalled();
  });
});
