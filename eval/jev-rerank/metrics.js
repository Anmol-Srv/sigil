const DEFAULT_CUTOFFS = [1, 3, 5];

function rankIds(facts, cutoff = Infinity) {
  return (Array.isArray(facts) ? facts : []).slice(0, cutoff).map((fact) => String(fact.id));
}

function reciprocalRank(ids, relevantIds, cutoff) {
  const relevant = new Set(relevantIds.map(String));
  const index = ids.slice(0, cutoff).findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function ndcg(ids, relevantIds, cutoff) {
  const relevant = new Set(relevantIds.map(String));
  const dcg = ids.slice(0, cutoff).reduce((sum, id, index) => (
    sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0)
  ), 0);
  const idealCount = Math.min(relevant.size, cutoff);
  const idcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return idcg ? dcg / idcg : 1;
}

function evaluateRanking(facts, { relevantIds = [], forbiddenIds = [], cutoffs = DEFAULT_CUTOFFS } = {}) {
  const ids = rankIds(facts);
  const relevant = new Set(relevantIds.map(String));
  const forbidden = new Set(forbiddenIds.map(String));
  const metrics = {
    resultCount: ids.length,
    relevantCount: relevant.size,
    forbiddenCount: forbidden.size,
  };

  for (const cutoff of cutoffs) {
    const top = ids.slice(0, cutoff);
    const relevantFound = top.filter((id) => relevant.has(id));
    const forbiddenFound = top.filter((id) => forbidden.has(id));
    metrics[`hitAt${cutoff}`] = relevantFound.length > 0 ? 1 : 0;
    metrics[`recallAt${cutoff}`] = relevant.size ? relevantFound.length / relevant.size : 1;
    metrics[`forbiddenAt${cutoff}`] = forbiddenFound.length > 0 ? 1 : 0;
  }

  const maxCutoff = Math.max(...cutoffs);
  metrics.mrrAt5 = reciprocalRank(ids, relevantIds, Math.min(5, maxCutoff));
  metrics.ndcgAt5 = ndcg(ids, relevantIds, Math.min(5, maxCutoff));
  return metrics;
}

function round(value, places = 4) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function mean(rows, field) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index];
}

function summarizePairs(pairs) {
  const baseline = pairs.map((pair) => pair.baseline);
  const decision = pairs.map((pair) => pair.decision);
  const metricNames = ['hitAt1', 'hitAt3', 'hitAt5', 'recallAt1', 'recallAt3', 'recallAt5', 'mrrAt5', 'ndcgAt5', 'forbiddenAt1', 'forbiddenAt3', 'forbiddenAt5'];
  const metrics = {};
  for (const name of metricNames) {
    const local = mean(baseline, name);
    const jev = mean(decision, name);
    metrics[name] = { local: round(local), jev: round(jev), delta: round(jev - local) };
  }

  let wins = 0;
  let ties = 0;
  let losses = 0;
  for (const pair of pairs) {
    const delta = pair.decision.mrrAt5 - pair.baseline.mrrAt5;
    if (delta > 0) wins += 1;
    else if (delta < 0) losses += 1;
    else ties += 1;
  }

  const applied = pairs.filter((pair) => pair.jev?.applied === true).length;
  const fallback = pairs.filter((pair) => pair.jev?.applied !== true).length;
  const graphPromotions = pairs.filter((pair) => pair.graphPromotedCount > 0).length;
  const latencyMs = pairs.map((pair) => pair.decisionLatencyMs).filter(Number.isFinite);

  return {
    cases: pairs.length,
    metrics,
    wins: { jev: wins, tie: ties, local: losses },
    provider: {
      applied,
      fallback,
      appliedRate: pairs.length ? round(applied / pairs.length) : 0,
      graphPromotionRate: pairs.length ? round(graphPromotions / pairs.length) : 0,
    },
    latencyMs: {
      p50: percentile(latencyMs, 0.5),
      p95: percentile(latencyMs, 0.95),
      mean: round(mean(latencyMs.map((value) => ({ value })), 'value'), 1),
    },
  };
}

export { DEFAULT_CUTOFFS, evaluateRanking, rankIds, summarizePairs };
