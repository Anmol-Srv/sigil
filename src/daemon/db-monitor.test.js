// Tests for the S1 embedded-DB recovery escalation + crash-loop guard. The
// recovery steps (rebuild PGlite → snapshot restore) are mocked; we assert the
// ESCALATION LOGIC and guard, not PGlite itself (that's the integration layer).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const raw = vi.fn();
const resetCortexPool = vi.fn().mockResolvedValue(undefined);
const setDbHealth = vi.fn();
const getDbHealth = vi.fn(() => ({ healthy: null }));
const latestSnapshot = vi.fn();
const recoverFromSnapshot = vi.fn();
let dbMode = 'embedded';

vi.mock('../db/cortex.js', () => ({ default: { raw }, resetCortexPool }));
vi.mock('./registry-holder.js', () => ({ setDbHealth, getDbHealth }));
vi.mock('../config.js', () => ({ get default() { return { db: { mode: dbMode } }; } }));
vi.mock('../db/snapshots.js', () => ({ latestSnapshot, recoverFromSnapshot }));

const { recoverEmbeddedDb, __resetRecoveryGuard } = await import('./db-monitor.js');

beforeEach(() => {
  vi.clearAllMocks();
  __resetRecoveryGuard();
  dbMode = 'embedded';
  getDbHealth.mockReturnValue({ healthy: null });
});

describe('recoverEmbeddedDb', () => {
  it('recovers by rebuilding the PGlite instance when a fresh SELECT 1 succeeds', async () => {
    raw.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const r = await recoverEmbeddedDb({ reason: 'test' });

    expect(r).toEqual({ recovered: true, via: 'reinstantiate' });
    expect(resetCortexPool).toHaveBeenCalledTimes(1); // dropped the dead pool
    expect(setDbHealth).toHaveBeenLastCalledWith(expect.objectContaining({ healthy: true }));
    expect(recoverFromSnapshot).not.toHaveBeenCalled(); // no need to restore
  });

  it('escalates to snapshot restore when reinstantiation does not clear the abort', async () => {
    raw.mockRejectedValueOnce(new Error('Aborted().')) // probe after pool reset still dead
       .mockResolvedValueOnce({ rows: [] });           // re-probe after restore succeeds
    latestSnapshot.mockReturnValue('/snap/latest.tgz');
    recoverFromSnapshot.mockResolvedValue({ restored: true });

    const r = await recoverEmbeddedDb({ reason: 'test' });

    expect(r).toEqual({ recovered: true, via: 'snapshot' });
    expect(recoverFromSnapshot).toHaveBeenCalledTimes(1);
    expect(setDbHealth).toHaveBeenLastCalledWith(expect.objectContaining({ healthy: true }));
  });

  it('leaves the DB unhealthy (no spin) when the cluster is dead and there is no snapshot', async () => {
    raw.mockRejectedValue(new Error('Aborted().'));
    latestSnapshot.mockReturnValue(null);

    const r = await recoverEmbeddedDb({ reason: 'test' });

    expect(r.recovered).toBe(false);
    expect(setDbHealth).toHaveBeenLastCalledWith(expect.objectContaining({ healthy: false }));
  });

  it('does not reinstantiate for a server-Postgres install (only embedded is rebuildable)', async () => {
    dbMode = 'url';
    raw.mockRejectedValue(new Error('ECONNREFUSED'));

    const r = await recoverEmbeddedDb({ reason: 'test' });

    expect(r.recovered).toBe(false);
    expect(recoverFromSnapshot).not.toHaveBeenCalled();
  });

  it('trips the crash-loop guard after repeated failed recoveries', async () => {
    raw.mockRejectedValue(new Error('Aborted().'));
    latestSnapshot.mockReturnValue(null);

    for (let i = 0; i < 5; i++) await recoverEmbeddedDb({ reason: 'test' });
    const guarded = await recoverEmbeddedDb({ reason: 'test' });

    expect(guarded).toEqual({ recovered: false, skipped: 'crash-loop' });
  });
});
