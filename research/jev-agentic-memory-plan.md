# Jev × Sigil: trustworthy graph-enhanced agent memory

## Executive decision

Use Jev as an **optional decision layer over an already-local, scope-filtered, graph-expanded shortlist**—not as the memory store, embedder, graph engine, or source of truth.

That architecture preserves Sigil’s local-first contract: Postgres/pgvector retrieves and traverses; Jev only answers bounded relevance decisions over selected candidates. A remote timeout, malformed response, unavailable provider, or low score leaves the local ordering intact. This is the correct reliability boundary because Jev’s documented interface is a constrained-decision API, while graph traversal remains application logic.[6][9][10]

## What is now implemented

### User-visible path

1. **Memory pipeline › Jev enhancements** now owns the masked `Save Jev key` form, the connection readout, the enable switch, and the tuning controls in one place.
2. Credential saving is local-only; the key is never returned to the UI and no remote request occurs until the user separately enables Jev.
3. **Memory pipeline › Jev enhancements** exposes a functional switch plus candidate count, relevance floor, and timeout.
4. Enabling without a saved key is rejected clearly instead of silently “succeeding.”
5. Graph expansion now reapplies namespace, pod, temporal, category, confidence, and visibility scope before it admits a related fact; Jev only sees that authorized candidate pool.
6. When graph-expanded recall runs, Sigil first performs normal local retrieval and scoped graph expansion; a small candidate pool lets Jev promote a related fact before the public result is trimmed to its requested limit.
7. The search RPC and causal trace expose sanitized Jev outcome metadata and per-fact retrieval provenance—applied/fallback reason, model, candidates, count re-ranked, score floor, tokens, direct/related/graph-reranked type, and failure status—not the API key or raw provider payload.

### Code flow map

| Stage | Existing / changed implementation | Contract |
|---|---|---|
| Configuration | `src/setup/config-store.js`, `src/config.js` | Device-local `jev` section defaults disabled; secret remains only in the mode-0600 Sigil config store. |
| Dashboard | `src/gui/web/index.html`, `src/gui/web/app.js`, `src/gui/web/settings.js`, `src/setup/settings-schema.js` | The Jev enhancement page combines its local-only credential save, connection readout, schema-driven toggle, and tuning controls. |
| Credential safety | `src/daemon/handlers/jev.js` | `jev.configure` persists a key without sending a remote request; `jev.status` returns only safe state. |
| System One client | `src/lib/jev.js` | POSTs to `/v1/systemone`, applies timeout/retry bounds, validates an answer envelope, and never lets a remote failure change local rank. |
| Local retrieval | `src/memory/search/hybrid.js`, `src/memory/search/graph-enhancement.js` | Hybrid SQL/vector/keyword + entity/Hebbian/graph expansion completes first; graph facts must re-pass every authorization filter and Jev receives a maximum of configured candidates. |
| Agent-facing response | `src/daemon/handlers/search.js` | Returns normal facts/chunks plus safe Jev metadata and direct/graph/reranker provenance; every local result remains available. |
| Observability | `src/memory/search/hybrid.js` causal trace | Records local score signals alongside an optional `jevScore` and the sanitized provider outcome. |

## Jev integration contract

Sigil uses the documented System One endpoint, `POST https://api.typesafe.ai/v1/systemone`, with `Authorization: Bearer <API_KEY>` and a model default pinned to `jev-1.13.0` (aliases like `jev-latest` move with releases and would invalidate calibrated thresholds).[4][6][12]

For each graph-enhanced search, the client sends:

- the query, truncated to 1,000 characters;
- at most 50, default 12, already-local candidates;
- per candidate: local identifier, fact text capped at 1,200 characters, and category;
- one independent **Noul** question per candidate: whether it directly answers or provides necessary evidence.

Noul supplies an estimated yes probability in `[0,1]`; it does not supply a separate confidence statistic.[7] Sigil therefore treats the configured floor as a **domain-calibrated promotion threshold**, not a claim of per-memory truth. Candidates below the threshold remain in their local order rather than being deleted. This preserves recall and makes the remote call a precision-oriented reranker.

The question prompt explicitly treats candidate text as untrusted memory rather than instructions. This narrows indirect prompt-injection exposure without pretending a remote classifier alone guarantees semantic safety.

## Reliability and privacy guardrails

| Risk | Implemented guardrail | Why it matters |
|---|---|---|
| Remote outage, timeout, malformed payload | Return original local ordering, attach a trace fallback reason | Recall never depends on Jev availability. |
| Rate limits / overload | Bounded retries for transient transport, 408, 429, 529, and 5xx failures; honour bounded retry hints | Typesafe documents backoff for 429/529 and its SDK uses bounded retry behavior.[6][13] |
| Bad credential | No remote request before explicit enablement; toggle refuses enablement with no saved key; a first-call failure preserves local ranking | Avoids silent remote transmission and a misleading enabled state. |
| Unbounded data egress | Candidate cap, per-fact/query truncation, graph-only invocation | Limits cost, latency, and remote exposure. |
| Secret exposure | Masked form, no response echo, schema excludes secret paths, safe settings summary | Keeps the key out of generic settings, traces, and dashboard readouts. |
| Overclaiming certainty | Noul floor is calibrated per evaluation set; no truth deletion | Typesafe warns calibration applies across groups, not individual answers.[3][8] |
| Silent behavior change | Causal trace records `jev` status plus per-result score | Operators can prove what changed and revert immediately. |

Typesafe’s policy says prompts are not used to train or fine-tune its models, but it does not establish zero retention; it describes collecting inputs and retaining personal data as reasonably necessary. Jev must therefore remain an explicit remote-processing boundary, never the default for sensitive or restricted pods.[11]

## How the current Sigil memory harness measures up

### Strong foundations already in the codebase

- **Capture and durable structure:** hook/session ingestion, documents/chunks/facts/entities/relations, and a Postgres/pgvector store.
- **Provenance and correctability:** fact lifecycle, source document pointers, agent/device attribution, temporal validity, and KB actions.
- **Isolation:** namespace, pod resolution, visibility rules, and an explicit scoped-search default in `src/daemon/handlers/search.js`.
- **Retrieval quality signals:** hybrid vector + keyword RRF, ACT-R access activation, importance/confidence multipliers, entity aliases, graph expansion, and decaying Hebbian co-retrieval.
- **Graceful degradation:** relevance floors, explicit DB health states, daemon queues, provider probes, and trace events.
- **Evaluation starting point:** `eval/longmemeval/`, reliability tests, and persisted scorecard history.

### Highest-value next steps

1. **Build a fixed recall benchmark before claiming a Jev uplift.** Create a versioned, redacted suite of query → expected fact IDs / acceptable answer sets across temporal, contradictory, cross-project, entity-chain, and adversarial-instruction cases. Measure Recall@K, MRR/NDCG, unsupported-answer rate, p50/p95 latency, remote fallback rate, and bytes/tokens sent.
2. **Run a shadow mode.** Compute Jev rankings and log them without changing injected context. Compare local vs Jev winners against judged examples; promote only after a predeclared quality/latency budget is met.
3. **Calibrate by memory class.** Preference, durable project decision, transient task state, and source-derived fact should not share one Noul floor. Store calibration version and threshold alongside each evaluation run.
4. **Add contradiction and temporal resolution to retrieval.** Retrieval should surface mutually exclusive active facts with validity/provenance rather than asking a reranker to choose one invisibly. Jev can score support, but Sigil should preserve both claims and make the resolution inspectable.
5. **Turn trace data into an operator scorecard.** Add dashboard readouts for Jev applied rate, fallback rate by error class, score distribution, rank displacement, latency percentiles, and evaluation delta. A system that cannot show why it recalled something is not dependable agent memory.
6. **Establish data-sensitivity policy per pod.** Add `remoteInference: allowed | local_only | approval_required` to pod policy before applying Jev. Default unclassified/sensitive pods to local only.
7. **Close the graph traversal loop.** The current implementation improves graph-expanded recall. A second phase can use documented Choice decisions over bounded neighbor sets for beam-search traversal, with a visited set, depth/branch budgets, local shortest-path fallback, and full path provenance.[10]

## Acceptance criteria for a defensible public result

Do not state that Jev “revolutionized” Sigil until a reproducible comparison reports all of:

- Same frozen corpus and query set; local ranker vs local + Jev.
- Quality: Recall@5, MRR/NDCG, unsupported-answer rate, contradiction-handling accuracy.
- Reliability: timeout/fallback rate, non-retryable error rate, and local parity when Jev is intentionally disabled.
- Speed: p50/p95 end-to-end recall latency and incremental Jev latency.
- Privacy: average/max candidates and characters sent; excluded pod count.
- Cost: request/token totals and budget per 1,000 recalls.
- Human review: at least a blind sample of rank changes, including “Jev harmed relevance” cases.

## Draft X post (only after benchmark results exist)

> We added Jev to Sigil’s graph memory stack—but not as a replacement for retrieval.
>
> Sigil still does local hybrid search, pod scoping, graph expansion and provenance first. Jev sees only a bounded shortlist and makes fast constrained relevance decisions. If it times out, overloads, or is uncertain, Sigil keeps the local rank unchanged.
>
> The key idea: agent memory needs more than a vector DB. It needs **precision gates, provenance, temporal validity, isolation, observability, and graceful fallback**.
>
> On our eval set, local + Jev moved [metric] from [baseline] to [result] at [p95]ms, with [fallback]% fallback and [candidate cap] candidates exposed per call.
>
> That is the architecture: local memory as truth, calibrated System One decisions as an optional precision layer.

Replace every bracketed field with measured numbers. The qualitative architecture claim is supportable now; a performance claim is not until the evaluation exists.

## Sources

[3] https://docs.typesafe.ai/confidence
[4] https://docs.typesafe.ai/introduction/quickstart
[6] https://docs.typesafe.ai/api
[7] https://docs.typesafe.ai/primitives/noul
[8] https://docs.typesafe.ai/concepts/system-one
[9] https://docs.typesafe.ai/cookbooks/rerank_typesafe
[10] https://docs.typesafe.ai/cookbooks/hierarchical_classification
[11] https://typesafe.ai/legal/privacy-policy
[12] https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/client.ts
[13] https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-js/main/src/retry.ts
