import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRaw } = vi.hoisted(() => ({ mockRaw: vi.fn() }));

vi.mock('../../db/cortex.js', () => ({
  default: Object.assign(vi.fn(), {
    raw: mockRaw,
    fn: { now: () => 'NOW()' },
  }),
}));

vi.mock('../../config.js', () => ({
  default: {
    hebbian: {
      entity: {
        enabled: true,
        eta: 1,
        cap: 50,
        halfLifeDays: 30,
        minEffective: 0.5,
        rrfWeight: 0.3,
        maxWriteEntities: 12,
        expandPerSeed: 3,
      },
    },
  },
}));

import config from '../../config.js';
import {
  strengthenEntityEdges,
  getCoRetrievedEntities,
  getEdgeStrengthsForRanking,
} from './entity-hebbian.js';

beforeEach(() => {
  vi.clearAllMocks();
  config.hebbian.entity.enabled = true;
});

describe('strengthenEntityEdges', () => {
  it('no-ops with fewer than 2 ids', async () => {
    await strengthenEntityEdges([42]);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('no-ops when disabled', async () => {
    config.hebbian.entity.enabled = false;
    await strengthenEntityEdges([1, 2, 3]);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('canonicalizes pair order (a < b) and dedupes', async () => {
    mockRaw.mockResolvedValue({ rows: [] });
    await strengthenEntityEdges([3, 1, 2, 1]);

    const [, params] = mockRaw.mock.calls[0];
    // Pairs from sorted unique [1,2,3]: (1,2), (1,3), (2,3)
    // Layout: [a1, b1, eta1, ..., lambda, eta_for_update, cap]
    expect(params).toEqual([
      1, 2, 1, 1, 3, 1, 2, 3, 1,
      expect.closeTo(Math.log(2) / 30, 9), 1, 50,
    ]);
  });

  it('decays the stored strength before incrementing, then caps', async () => {
    mockRaw.mockResolvedValue({ rows: [] });
    await strengthenEntityEdges([10, 20]);

    const [sql] = mockRaw.mock.calls[0];
    // The decay must read entity_hebbian_edge.last_seen_at (the PRE-update
    // value); reading the excluded/new row would discount nothing.
    expect(sql).toMatch(/LEAST\(\s*entity_hebbian_edge\.strength/);
    expect(sql).toMatch(/EXP\(-1\.0 \* \?::float8 \* EXTRACT\(EPOCH FROM \(NOW\(\) - entity_hebbian_edge\.last_seen_at\)\) \/ 86400\.0\)/);
    expect(sql).toMatch(/\+ \?, \?\)/);
    expect(sql).toMatch(/last_seen_at = NOW\(\)/);
  });

  it('an old edge touched once does not regain its full historical strength', async () => {
    mockRaw.mockResolvedValue({ rows: [] });
    await strengthenEntityEdges([10, 20]);

    const [, params] = mockRaw.mock.calls[0];
    const [lambda, eta, cap] = params.slice(-3);
    const settle = (strength, days) => Math.min(strength * Math.exp(-lambda * days) + eta, cap);
    // 50 (saturated) untouched for two half-lives → 12.5 + 1, not 50.
    expect(settle(50, 60)).toBeCloseTo(13.5, 6);
    // A freshly-touched edge still climbs normally.
    expect(settle(10, 0)).toBeCloseTo(11, 6);
  });

  it('filters non-integer entity IDs', async () => {
    mockRaw.mockResolvedValue({ rows: [] });
    await strengthenEntityEdges([1, '2', null, undefined, 3.5, 4]);
    const [, params] = mockRaw.mock.calls[0];
    // Only [1, 4] survive — single pair
    expect(params).toEqual([1, 4, 1, expect.closeTo(Math.log(2) / 30, 9), 1, 50]);
  });
});

describe('getCoRetrievedEntities', () => {
  it('returns rows with decay applied in SQL, filtered by minEffective', async () => {
    mockRaw.mockResolvedValue({
      rows: [
        { partnerId: 99, effectiveStrength: 2.4, rawStrength: 3, lastSeenAt: new Date() },
        { partnerId: 88, effectiveStrength: 0.1, rawStrength: 0.2, lastSeenAt: new Date() },
      ],
    });

    const out = await getCoRetrievedEntities(42, { limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].partnerId).toBe(99);
  });

  it('returns empty array when disabled', async () => {
    config.hebbian.entity.enabled = false;
    const out = await getCoRetrievedEntities(42);
    expect(out).toEqual([]);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('uses lambda = ln(2) / halfLifeDays in the decay term', async () => {
    mockRaw.mockResolvedValue({ rows: [] });
    await getCoRetrievedEntities(42, { halfLifeDays: 30 });
    const [, params] = mockRaw.mock.calls[0];
    const lambda = params[1];
    expect(lambda).toBeCloseTo(Math.log(2) / 30, 6);
  });
});

describe('getEdgeStrengthsForRanking', () => {
  it('returns empty Map when no seeds or candidates', async () => {
    expect((await getEdgeStrengthsForRanking([], [1])).size).toBe(0);
    expect((await getEdgeStrengthsForRanking([1], [])).size).toBe(0);
  });

  it('returns empty Map when candidates are all in seed set', async () => {
    const out = await getEdgeStrengthsForRanking([1, 2], [1, 2]);
    expect(out.size).toBe(0);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('returns Map of candidateId → summed decayed strength', async () => {
    mockRaw.mockResolvedValue({
      rows: [
        { candidateId: 100, summedStrength: 4.2 },
        { candidateId: 200, summedStrength: 1.1 },
      ],
    });

    const out = await getEdgeStrengthsForRanking([1, 2], [100, 200]);
    expect(out.size).toBe(2);
    expect(out.get(100)).toBe(4.2);
    expect(out.get(200)).toBe(1.1);
  });
});
