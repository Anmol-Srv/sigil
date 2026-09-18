#!/usr/bin/env node
/**
 * Paired evaluation for Jev over an immutable, already-local candidate list.
 *
 * This deliberately does not run two end-to-end searches: access tracking and
 * Hebbian updates mutate the second search. It measures only the decision layer
 * against the exact same local ranking and manually judged relevance labels.
 *
 * Usage:
 *   node eval/jev-rerank/run-eval.js --mode=fixture --corpus=eval/jev-rerank/example-corpus.json
 *   node eval/jev-rerank/run-eval.js --mode=live --corpus=/absolute/path/to/judged-corpus.json --report=benchmarks/jev/report.json
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { rerankFacts } from '../../src/lib/jev.js';
import config from '../../src/config.js';
import { evaluateRanking, summarizePairs } from './metrics.js';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function safeSettings({ floor } = {}) {
  const settings = config.jev || {};
  const minScore = floor == null ? settings.minScore : Number(floor);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error('--floor must be a number from 0 to 1');
  return {
    enabled: settings.enabled === true,
    apiKey: settings.apiKey || '',
    model: settings.model || 'jev-1.13.0',
    timeoutMs: settings.timeoutMs || 10_000,
    maxRetries: settings.maxRetries ?? 2,
    maxCandidates: settings.maxCandidates ?? 12,
    minScore,
    injectionMax: settings.injectionMax ?? 0.7,
  };
}

// One request per candidate now, so the fixture has to resolve each call by the
// candidate it carries rather than by position in a single packed request.
function fixtureFetch(testCase) {
  const byContent = new Map(testCase.candidates.map((candidate, index) => [
    String(candidate.content || '').slice(0, 1200),
    {
      relevance: testCase.fixtureScores[index],
      injection: Array.isArray(testCase.fixtureInjectionScores) ? testCase.fixtureInjectionScores[index] : 0,
    },
  ]));
  return async (_url, init) => {
    const { candidate } = JSON.parse(init.body).state;
    const scored = byContent.get(candidate.content);
    if (!scored) throw new Error('Fixture case is missing a score for a candidate sent to Jev');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({
        model: 'fixture-system-one',
        answers: {
          answers_query: { type: 'noul', noul: scored.relevance },
          contains_prompt_injection: { type: 'noul', noul: scored.injection },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    };
  };
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function mergeLabels(corpus, labelDocument) {
  if (!labelDocument || typeof labelDocument !== 'object' || !labelDocument.cases || typeof labelDocument.cases !== 'object') {
    throw new Error('Labels must be an object with a cases map keyed by corpus case ID.');
  }
  const assignedIds = new Set(Object.keys(labelDocument.cases));
  const cases = corpus.cases.map((testCase) => {
    const labels = labelDocument.cases[testCase.id];
    if (!labels) throw new Error(`Missing labels for corpus case ${testCase.id}`);
    assignedIds.delete(testCase.id);
    const candidateIds = new Set(testCase.candidates.map((candidate) => String(candidate.id)));
    for (const field of ['relevantIds', 'forbiddenIds']) {
      if (!Array.isArray(labels[field])) throw new Error(`Labels for ${testCase.id} need ${field}.`);
      const unknown = labels[field].map(String).filter((id) => !candidateIds.has(id));
      if (unknown.length) throw new Error(`Labels for ${testCase.id} reference unknown candidate IDs: ${unknown.join(', ')}`);
    }
    return {
      ...testCase,
      relevantIds: labels.relevantIds.map(String),
      forbiddenIds: labels.forbiddenIds.map(String),
    };
  });
  if (assignedIds.size) throw new Error(`Labels contain unknown corpus cases: ${[...assignedIds].join(', ')}`);
  return { ...corpus, cases, labelStatus: labelDocument.labelStatus || corpus.labelStatus };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || 'fixture';
  if (!['fixture', 'live'].includes(mode)) throw new Error('--mode must be fixture or live');
  if (!args.corpus) throw new Error('--corpus=/path/to/judged-corpus.json is required');

  const corpusPath = resolve(args.corpus);
  const corpusText = await readFile(corpusPath, 'utf8');
  let corpus = JSON.parse(corpusText);
  if (!Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error('Corpus must contain a non-empty cases array');
  let labelInfo = null;
  if (args.labels) {
    const labelsPath = resolve(args.labels);
    const labelsText = await readFile(labelsPath, 'utf8');
    const labels = JSON.parse(labelsText);
    corpus = mergeLabels(corpus, labels);
    labelInfo = {
      path: labelsPath,
      sha256: createHash('sha256').update(labelsText).digest('hex'),
      status: corpus.labelStatus || null,
      reviewMethod: labels.reviewMethod || null,
    };
  }
  // 'reviewed' is the only status that supports a public claim. The agent
  // statuses are allowed so the loop can be run at all, and the report carries
  // the status forward so no reader can mistake one for the other.
  const ACCEPTED_LABEL_STATUS = ['reviewed', 'agent-double-reviewed', 'agent-reviewed'];
  if (mode === 'live' && !ACCEPTED_LABEL_STATUS.includes(corpus.labelStatus)) {
    throw new Error(`Live quality reports require labelStatus to be one of ${ACCEPTED_LABEL_STATUS.join(', ')} with a complete labels file.`);
  }
  if (mode === 'live' && corpus.labelStatus !== 'reviewed') {
    console.warn(`\n!! labelStatus="${corpus.labelStatus}" — indicative only, not publishable. Human review is what makes a number claimable.\n`);
  }

  const settings = safeSettings({ floor: args.floor });
  if (mode === 'live' && (!settings.enabled || !settings.apiKey)) {
    throw new Error('Live mode requires Jev to be configured and enabled in Settings. The key is never read into the report.');
  }

  const pairs = [];
  for (const testCase of corpus.cases) {
    if (!testCase.id || !testCase.query || !Array.isArray(testCase.candidates) || !Array.isArray(testCase.relevantIds)) {
      throw new Error(`Invalid corpus case: ${JSON.stringify(testCase.id || testCase)}`);
    }
    if (mode === 'fixture' && (!Array.isArray(testCase.fixtureScores) || testCase.fixtureScores.length !== testCase.candidates.length)) {
      throw new Error(`Fixture case ${testCase.id} needs one fixtureScores value per candidate`);
    }

    const localFacts = testCase.candidates.map((fact) => ({ ...fact }));
    const baseline = evaluateRanking(localFacts, testCase);
    const start = performance.now();
    const result = await rerankFacts(testCase.query, localFacts, {
      settings,
      ...(mode === 'fixture' ? { fetchImpl: fixtureFetch(testCase) } : {}),
    });
    const decisionLatencyMs = Math.round(performance.now() - start);
    const decision = evaluateRanking(result.facts, testCase);
    const graphPromotedCount = result.facts.filter((fact) => fact.resultType === 'graph-reranked' && fact.reranker === 'jev').length;

    pairs.push({
      id: testCase.id,
      stratum: testCase.stratum || 'unlabeled',
      baseline,
      decision,
      decisionLatencyMs,
      graphPromotedCount,
      droppedCount: result.meta.dropped ?? 0,
      jev: result.meta,
      localRankedIds: localFacts.map((fact) => String(fact.id)),
      decisionRankedIds: result.facts.map((fact) => String(fact.id)),
    });
  }

  const publicSettings = {
    enabled: settings.enabled,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    maxCandidates: settings.maxCandidates,
    minScore: settings.minScore,
    injectionMax: settings.injectionMax,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    corpus: {
      path: corpusPath,
      sha256: createHash('sha256').update(corpusText).digest('hex'),
      schemaVersion: corpus.schemaVersion ?? null,
      cases: corpus.cases.length,
      labelStatus: corpus.labelStatus || null,
      labels: labelInfo,
    },
    mode,
    settings: publicSettings,
    summary: summarizePairs(pairs),
    cases: pairs,
  };

  const reportPath = resolve(args.report || `benchmarks/jev/jev-rerank-${mode}-${Date.now()}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const { metrics, provider, latencyMs, wins } = report.summary;
  console.log(`Jev paired evaluation (${mode}) — ${report.summary.cases} cases`);
  console.log(`MRR@5 local=${metrics.mrrAt5.local} Jev=${metrics.mrrAt5.jev} delta=${metrics.mrrAt5.delta}`);
  console.log(`Hit@1 local=${metrics.hitAt1.local} Jev=${metrics.hitAt1.jev} delta=${metrics.hitAt1.delta}`);
  console.log(`Safety forbidden@5 local=${metrics.forbiddenAt5.local} Jev=${metrics.forbiddenAt5.jev}`);
  console.log(`Provider applied=${provider.applied}/${report.summary.cases} graphPromotionRate=${provider.graphPromotionRate} latency p50=${latencyMs.p50}ms p95=${latencyMs.p95}ms`);
  console.log(`Wins Jev=${wins.jev} tie=${wins.tie} local=${wins.local}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(`Jev paired evaluation failed: ${error.message}`);
  process.exitCode = 1;
});
