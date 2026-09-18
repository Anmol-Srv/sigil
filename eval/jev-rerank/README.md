# Jev paired reranking evaluation

Jev scores **one query/candidate pair per request** (TypeSafe's own reranking cookbook does the same): jev-1.13 loses accuracy when a state carries content the question doesn't need, and when a question has to reach a candidate by index. Each request asks two independent Nouls over that pair — `answers_query` (reorder) and `contains_prompt_injection` (drop).

This harness measures the **decision layer only**. It freezes an ordered local candidate shortlist, scores that same list as the baseline, then applies the production `rerankFacts()` adapter to it. It does not issue two full searches, because search access tracking and Hebbian learning make a later search non-identical.

## Corpus contract

Provide a JSON corpus with manually reviewed labels:

```json
{
  "schemaVersion": 1,
  "labelStatus": "reviewed",
  "cases": [
    {
      "id": "graph-related-decision-01",
      "stratum": "graph-related",
      "query": "Why was the cache removed?",
      "candidates": [
        { "id": "f1", "content": "…", "category": "decision", "resultType": "direct" },
        { "id": "f2", "content": "…", "category": "decision", "resultType": "related" }
      ],
      "relevantIds": ["f1", "f2"],
      "forbiddenIds": ["f9"],
      "fixtureScores": [0.9, 0.7],
      "fixtureInjectionScores": [0.0, 0.0]
    }
  ]
}
```

- Label candidates before seeing Jev’s scores.
- Include 20–50 cases split across direct recall, graph-related recall, paraphrases, and scope-safety cases.
- `forbiddenIds` must include cross-scope or explicitly unsafe candidates. Their rate at every cutoff must remain zero.
- Do not put real secrets, document paths, or private fact text in a committed corpus. Keep personal corpora in `benchmarks/`, which is ignored.

`example-corpus.json` is only a deterministic fixture. It cannot support a public performance claim.

## Capture a private baseline corpus

Start with a question list in the ignored `benchmarks/` directory, then capture
the local graph-enabled ranking through the daemon:

```bash
node eval/jev-rerank/capture-corpus.js \
  --questions=benchmarks/jev/questions.json \
  --out=benchmarks/jev/corpus-draft.json
```

The capture writes a JSON draft and a Markdown review sheet. It temporarily
disables Jev to freeze the local baseline, restores the previous enabled state,
and verifies the restore before it exits. Review every candidate independently,
fill `relevantIds` and `forbiddenIds`, and only then change
`labelStatus` from `draft-unreviewed` to `reviewed`. Live evaluation refuses an
unreviewed corpus. An automated double review can be stored in a separate labels
file with `labelStatus: "agent-double-reviewed"`; disclose that label source in
any report or public post.

## Run

CI-safe fixture run (no key or network):

```bash
node eval/jev-rerank/run-eval.js \
  --mode=fixture \
  --corpus=eval/jev-rerank/example-corpus.json
```

Live run against a manually judged corpus. Jev must already be enabled in Settings; the report never contains the API key or candidate text:

```bash
node eval/jev-rerank/run-eval.js \
  --mode=live \
  --corpus=benchmarks/jev/my-judged-corpus.json \
  --labels=benchmarks/jev/my-labels.json \
  --report=benchmarks/jev/live-report.json
```

Use `--floor=0.55` to test a proposed decision threshold **without persisting a setting**.

## What to publish

Report the corpus hash, Git SHA, model returned by Jev, date, sample size, and strata. Publish paired MRR@5, Hit@1/3/5, nDCG@5 (when labels are graded), forbidden-item rate, Jev applied/fallback rate, graph-promotion rate, injection-drop count, and p50/p95 added latency. Pin the model id (`jev-1.13.0`, not `jev-latest`) — thresholds are calibrated per model and aliases move.

Do not claim an uplift from a fixture, a single query, an unjudged corpus, or a result whose paired confidence interval crosses zero.
