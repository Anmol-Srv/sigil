# Jev × Sigil retrieval calibration scorecard

**Run:** 2026-09-17 10:44 UTC  
**Code:** `19ded00591761afd3a0ae13f57a9de41cf265ad8`  
**Decision model returned:** `jev-1.13.0`  
**Operating threshold selected:** `0.50`

## What was measured

This is a paired reranking evaluation, not two separate searches. For each case,
Sigil first froze the exact local graph-enabled candidate order. The local order
was scored as baseline. The production Jev adapter then reranked that same list.
This prevents access tracking and Hebbian updates from biasing the second arm.

- **Corpus:** 12 private real-memory queries; 12 local candidates per query.
- **Labels:** two independent agent reviews per candidate list; conservative
  intersection only. This is **agent-double-reviewed**, not human reviewed.
- **Metrics:** Hit@K, Recall@K, MRR@5, nDCG@5, known-forbidden candidate rate,
  provider application rate, and added decision latency.
- **Safety boundary:** namespace, pod, visibility, temporal, category, and
  confidence filtering occurred locally before the candidate list reached Jev.

This is useful as a calibration run. It is too small, agent-labeled, and
single-store-specific to support a general benchmark claim.

## Threshold sweep

| Jev floor | MRR@5 | Δ MRR@5 | Hit@1 | Recall@5 | Forbidden@5 | Safety regression | p50 / p95 added latency |
|---:|---:|---:|---:|---:|---:|---|---:|
| Local baseline | 0.2722 | — | 0.0% | 68.1% | 33.3% | — | — |
| 0.70 | 0.6375 | +0.3653 | 58.3% | 72.2% | 33.3% | none | 551 / 1242 ms |
| **0.50** | **0.8708** | **+0.5986** | **83.3%** | **94.4%** | **33.3%** | **none** | **384 / 1268 ms** |
| 0.30 | 0.8917 | +0.6194 | 83.3% | 94.4% | 41.7% | migration-dashboard-archive | 369 / 1208 ms |
| 0.00 | 0.8778 | +0.6056 | 83.3% | 97.2% | 41.7% | migration-dashboard-archive | 373 / 1269 ms |

## Decision

Set the operational Jev floor to **0.50**.

It gives the strongest result that does not increase the known-forbidden rate:

- MRR@5: `0.2722 → 0.8708` (+`0.5986`)
- Hit@1: `0.0% → 83.3%` (+`83.3` percentage points)
- Recall@5: `68.1% → 94.4%` (+`26.4` percentage points)
- nDCG@5: `0.3552 → 0.8765` (+`0.5213`)
- Jev won 10 cases, tied 2, and lost 0 by MRR@5.
- Jev applied on all 12 calls; p50 added decision latency was 384 ms and p95 was 1268 ms.

The live production-path check after setting `0.50` reranked 3 of 12 local
candidates for a migration dependency query. It completed in 1105 ms.

## Important limitations

- The baseline itself contained known-forbidden candidates in 4 of 12 top-five
  lists. Jev did not make that worse at the chosen threshold, but this is not a
  claim of perfect safety.
- The captured corpus produced zero `graph-reranked` facts. Do not claim a
  graph-promotion improvement from this run. Add a graph-specific candidate
  corpus before making that claim.
- No confidence interval is reported. N=12 is a calibration set, not a broad
  benchmark. Expand to 20–50 cases and add human review before headline claims.
- Jev remains opt-in. Local retrieval and authorization remain authoritative;
  disabled, unavailable, malformed, and below-threshold outcomes retain local
  ordering.

## Public draft — accurate, narrow framing

> I added Jev as a bounded decision layer on top of Sigil’s local, graph-aware memory retrieval—not as a replacement for the memory store or its access controls.
>
> On a private 12-query calibration set with frozen local candidate lists, Jev 1.13 at a 0.50 relevance floor moved MRR@5 from 0.27 → 0.87 and Hit@1 from 0% → 83%. Recall@5 went from 68% → 94%, with ~384 ms p50 added decision latency.
>
> Local filtering, provenance, and deterministic fallback stay intact. This is an agent-double-reviewed calibration run, not a general benchmark yet; next is a larger human-reviewed graph corpus.

Do not publish “graph recall improved” or a broad speed/accuracy claim from this run. The evidence supports a measured improvement in ranking this specific private calibration corpus.
