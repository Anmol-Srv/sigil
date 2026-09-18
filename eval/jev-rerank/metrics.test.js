import { describe, expect, it } from 'vitest';

import { evaluateRanking, summarizePairs } from './metrics.js';

const facts = (ids) => ids.map((id) => ({ id }));

describe('Jev paired-evaluation metrics', () => {
  it('computes cutoff metrics, MRR, nDCG, and forbidden-item detection', () => {
    const metrics = evaluateRanking(facts(['noise', 'support', 'answer', 'forbidden']), {
      relevantIds: ['answer', 'support'],
      forbiddenIds: ['forbidden'],
    });

    expect(metrics).toMatchObject({
      hitAt1: 0,
      hitAt3: 1,
      recallAt3: 1,
      mrrAt5: 0.5,
      forbiddenAt3: 0,
      forbiddenAt5: 1,
    });
    expect(metrics.ndcgAt5).toBeGreaterThan(0.6);
  });

  it('reports paired quality deltas separately from provider coverage and latency', () => {
    const summary = summarizePairs([
      {
        baseline: { mrrAt5: 0.5, hitAt1: 0, hitAt3: 1, hitAt5: 1, recallAt1: 0, recallAt3: 1, recallAt5: 1, ndcgAt5: 0.7, forbiddenAt1: 0, forbiddenAt3: 0, forbiddenAt5: 0 },
        decision: { mrrAt5: 1, hitAt1: 1, hitAt3: 1, hitAt5: 1, recallAt1: 1, recallAt3: 1, recallAt5: 1, ndcgAt5: 1, forbiddenAt1: 0, forbiddenAt3: 0, forbiddenAt5: 0 },
        jev: { applied: true }, decisionLatencyMs: 40, graphPromotedCount: 1,
      },
      {
        baseline: { mrrAt5: 1, hitAt1: 1, hitAt3: 1, hitAt5: 1, recallAt1: 1, recallAt3: 1, recallAt5: 1, ndcgAt5: 1, forbiddenAt1: 0, forbiddenAt3: 0, forbiddenAt5: 0 },
        decision: { mrrAt5: 1, hitAt1: 1, hitAt3: 1, hitAt5: 1, recallAt1: 1, recallAt3: 1, recallAt5: 1, ndcgAt5: 1, forbiddenAt1: 0, forbiddenAt3: 0, forbiddenAt5: 0 },
        jev: { applied: false, reason: 'disabled' }, decisionLatencyMs: 60, graphPromotedCount: 0,
      },
    ]);

    expect(summary).toMatchObject({
      cases: 2,
      wins: { jev: 1, tie: 1, local: 0 },
      provider: { applied: 1, fallback: 1, appliedRate: 0.5, graphPromotionRate: 0.5 },
      latencyMs: { p50: 40, p95: 60, mean: 50 },
    });
    expect(summary.metrics.mrrAt5).toEqual({ local: 0.75, jev: 1, delta: 0.25 });
  });
});
