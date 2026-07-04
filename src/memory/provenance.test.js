// Unit test for currentOrigin (P7) — the ownership identity used by BOTH the
// write side (stamping created_by_origin) and the read side (owner-scoped
// visibility). Precedence: RPC device id → ctx.device.id → local config id.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ rpc: null, cfg: {} }));

vi.mock('../daemon/request-context.js', () => ({
  currentDeviceId: () => state.rpc,
}));
vi.mock('../setup/config-store.js', () => ({
  getConfig: () => state.cfg,
}));

import { currentOrigin } from './provenance.js';

beforeEach(() => {
  state.rpc = null;
  state.cfg = {};
});

describe('currentOrigin (P7 ownership identity)', () => {
  it('prefers the RPC device id, as a string', () => {
    state.rpc = 5;
    state.cfg = { device: { id: 'uuid-local' } };
    expect(currentOrigin()).toBe('5');
  });

  it('uses ctx.device.id when there is no RPC id', () => {
    state.cfg = { device: { id: 'uuid-local' } };
    expect(currentOrigin({ device: { id: 'uuid-ctx' } })).toBe('uuid-ctx');
  });

  it('falls back to the local config device id (UUID) for local installs', () => {
    state.cfg = { device: { id: 'uuid-local' } };
    expect(currentOrigin()).toBe('uuid-local');
  });

  it('returns null when nothing resolves (fail-open to global visibility)', () => {
    state.cfg = {};
    expect(currentOrigin()).toBeNull();
  });
});
