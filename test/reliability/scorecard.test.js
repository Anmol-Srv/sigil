// Reliability scorecard — turns the behavioral suites into TRACKED METRICS and
// a hard gate. Runs a labeled eval set (queries with known relevant + forbidden
// facts) through the real retrieval stack, computes precision / recall /
// leak-rate, writes a scorecard the team can watch over time, and FAILS the
// build on regression.
//
//   precision  — of the facts we surfaced, how many were relevant
//   recall     — of the relevant facts, how many we surfaced
//   leak-rate  — fraction of cases where a forbidden fact leaked in (the
//                cross-project / off-topic injection bug). MUST be zero.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Gate thresholds. Leak-rate is the hard one (cross-scope / off-topic
// injection must never happen). Recall raised to 0.8 now that real numbers
// show 1.0; precision stays 0.75 (the no-floor leak-check case legitimately
// surfaces in-scope-but-not-target facts, which is expected, not a defect).
const GATE = { minPrecision: 0.75, minRecall: 0.8, maxLeakRate: 0 };

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('reliability scorecard', () => {
  let ctx;
  const auth = {}; // named fact ids
  const cook = {};
  let podAuth;
  let podCook;

  beforeAll(async () => {
    ctx = await createReliabilityContext();
    podAuth = await ctx.seedPod({ type: 'project', externalId: '/proj/auth' });
    podCook = await ctx.seedPod({ type: 'project', externalId: '/proj/cook' });

    auth.jwt = (await ctx.seedFact({ content: 'Login issues JWT access tokens signed with RS256.', podUid: podAuth.uid })).factId;
    auth.session = (await ctx.seedFact({ content: 'User sessions expire after 30 minutes of inactivity.', podUid: podAuth.uid })).factId;
    auth.reset = (await ctx.seedFact({ content: 'Password reset links are single-use and expire in one hour.', podUid: podAuth.uid })).factId;

    cook.sourdough = (await ctx.seedFact({ content: 'Sourdough needs a 24 hour cold ferment in the fridge.', podUid: podCook.uid })).factId;
    cook.steak = (await ctx.seedFact({ content: 'Sear steak on high heat to build a crust before resting.', podUid: podCook.uid })).factId;
    cook.onions = (await ctx.seedFact({ content: 'Caramelizing onions takes about 40 minutes on low heat.', podUid: podCook.uid })).factId;
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('meets the reliability gate (precision / recall / leak-rate)', async () => {
    // Labeled cases: query, scope, which fact set is relevant, which is
    // forbidden, and whether the injection floor is on (auto-injection) or off.
    const allAuth = Object.values(auth);
    const allCook = Object.values(cook);
    // Per-query relevant sets (the fact the query is actually about), not the
    // whole topic — that's how retrieval precision/recall is properly scored.
    const cases = [
      { name: 'jwt (inject)', q: 'how does login token signing work', scope: [podAuth.uid], floor: true, relevant: [auth.jwt], forbidden: allCook },
      { name: 'session (inject)', q: 'when do user sessions time out', scope: [podAuth.uid], floor: true, relevant: [auth.session], forbidden: allCook },
      { name: 'sourdough (inject)', q: 'how long to cold ferment sourdough', scope: [podCook.uid], floor: true, relevant: [cook.sourdough], forbidden: allAuth },
      // Paraphrase robustness: the query shares no keywords with the fact
      // ("time out" vs "expire", "stay logged in") — semantic recall must hold.
      { name: 'paraphrase (inject)', q: 'how long can I stay logged in before being kicked out', scope: [podAuth.uid], floor: true, relevant: [auth.session], forbidden: allCook },
      // Cross-scope leak guard: B-topic query scoped to A, no floor — A facts
      // may show (in-scope) but no B fact may leak.
      { name: 'cross-scope-leak (search)', q: 'how to sear a steak crust', scope: [podAuth.uid], floor: false, relevant: [], forbidden: allCook },
      { name: 'off-topic (inject)', q: 'best programming language for game dev', scope: [podAuth.uid], floor: true, relevant: [], forbidden: [...allAuth, ...allCook] },
    ];

    const perCase = [];
    let pSum = 0;
    let rSum = 0;
    let rCount = 0;
    let leaked = 0;

    for (const c of cases) {
      const res = await ctx.doSearch(c.q, { podScope: c.scope, applyFloor: c.floor, limit: 10 });
      const got = res.facts.map((f) => f.id);
      const relevantGot = got.filter((id) => c.relevant.includes(id));
      const forbiddenGot = got.filter((id) => c.forbidden.includes(id));

      // precision: relevant / surfaced. Expect-empty cases score 1.0 when empty.
      const precision = got.length === 0 ? 1 : relevantGot.length / got.length;
      pSum += precision;
      // recall only counts when there's something to recall.
      if (c.relevant.length) { rSum += relevantGot.length / c.relevant.length; rCount++; }
      const didLeak = forbiddenGot.length > 0;
      if (didLeak) leaked++;

      perCase.push({ name: c.name, surfaced: got.length, precision: round(precision), leaked: didLeak });
    }

    const precision = round(pSum / cases.length);
    const recall = round(rCount ? rSum / rCount : 1);
    const leakRate = round(leaked / cases.length);

    const scorecard = {
      ts: new Date().toISOString(),
      commit: process.env.GITHUB_SHA || process.env.SIGIL_COMMIT || 'local',
      model: 'ollama:nomic-embed-text',
      precision, recall, leakRate,
      cases: cases.length,
      gate: GATE,
      perCase,
    };

    // Write latest + append history (tracked over time).
    try {
      mkdirSync(HERE, { recursive: true });
      writeFileSync(resolve(HERE, 'scorecard.json'), JSON.stringify(scorecard, null, 2));
      appendFileSync(resolve(HERE, 'scorecard-history.jsonl'), JSON.stringify(scorecard) + '\n');
    } catch { /* report is best-effort; the gate below is what matters */ }

    // eslint-disable-next-line no-console
    console.log(`\n[scorecard] precision=${precision} recall=${recall} leakRate=${leakRate} (gate: p>=${GATE.minPrecision} r>=${GATE.minRecall} leak<=${GATE.maxLeakRate})\n`);

    // The gate.
    expect(leakRate).toBeLessThanOrEqual(GATE.maxLeakRate);
    expect(precision).toBeGreaterThanOrEqual(GATE.minPrecision);
    expect(recall).toBeGreaterThanOrEqual(GATE.minRecall);
  });
});

function round(n) { return Math.round(n * 1000) / 1000; }
