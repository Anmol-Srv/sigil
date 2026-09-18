#!/usr/bin/env node
/**
 * Capture a private, local-ranker baseline corpus through the daemon.
 *
 * Output belongs under benchmarks/ (gitignored): it contains private memory
 * snippets. The script temporarily disables Jev only while it captures the
 * local ordering, then restores the prior enabled state and verifies it.
 *
 * Usage:
 *   node eval/jev-rerank/capture-corpus.js \
 *     --questions=benchmarks/jev/questions.json \
 *     --out=benchmarks/jev/corpus-draft.json
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { daemonCall } from '../../src/mcp/daemon-call.js';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function normalizeQuestions(input) {
  const cases = Array.isArray(input) ? input : input.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error('Questions must be a non-empty array or { cases: [...] }.');
  const seen = new Set();
  return cases.map((testCase) => {
    const id = String(testCase.id || '').trim();
    const query = String(testCase.query || '').trim();
    if (!id || !query) throw new Error('Every question needs an id and query.');
    if (seen.has(id)) throw new Error(`Duplicate question id: ${id}`);
    seen.add(id);
    return { id, query, stratum: String(testCase.stratum || 'unlabeled') };
  });
}

function asCandidate(fact) {
  return {
    id: String(fact.id),
    content: String(fact.content || ''),
    category: fact.category || null,
    resultType: fact.resultType || 'direct',
    relationPath: fact.relationPath || null,
    graphDistance: Number.isFinite(Number(fact.graphDistance)) ? Number(fact.graphDistance) : null,
  };
}

function renderReview(corpus) {
  const lines = [
    '# Jev corpus review',
    '',
    'This is private local-memory content. Do not commit it or quote it publicly.',
    'For each case, add relevant candidate IDs and forbidden candidate IDs to `corpus-draft.json`.',
    'Label before running the Jev evaluator. A candidate is relevant only if it directly answers or is necessary evidence.',
    '',
  ];
  for (const testCase of corpus.cases) {
    lines.push(`## ${testCase.id} — ${testCase.stratum}`);
    lines.push('', `**Query:** ${testCase.query}`, '');
    for (const [index, candidate] of testCase.candidates.entries()) {
      const provenance = candidate.resultType === 'related'
        ? ` · graph ${candidate.relationPath || 'related'} · distance ${candidate.graphDistance ?? '?'}`
        : '';
      lines.push(`- [ ] **${candidate.id}** (${candidate.category || 'uncategorized'}${provenance}) — ${candidate.content}`);
    }
    lines.push('', '**Relevant IDs:** `[]`  ', '**Forbidden IDs:** `[]`', '');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.questions) throw new Error('--questions=/path/to/questions.json is required');
  const questionsPath = resolve(args.questions);
  const questionsText = await readFile(questionsPath, 'utf8');
  const questions = normalizeQuestions(JSON.parse(questionsText));
  const limit = Number(args.limit || 12);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be an integer from 1 to 50');

  const outputPath = resolve(args.out || 'benchmarks/jev/corpus-draft.json');
  const reviewPath = outputPath.replace(/\.json$/i, '-review.md');
  const statusBefore = await daemonCall('jev.status');
  let statusAfter;
  let captured;

  try {
    if (statusBefore.enabled) await daemonCall('settings.set', { updates: { 'jev.enabled': false } });
    captured = [];
    for (const question of questions) {
      const response = await daemonCall('search', {
        query: question.query,
        useGraph: true,
        route: false,
        limit,
        podScope: 'global',
        // Synthesis is an LLM call per case and plays no part in which
        // candidates come back or in what order.
        synthesize: false,
        includeCandidatePool: true,
      });
      if (response.jev?.applied) throw new Error(`Jev unexpectedly ran while capturing ${question.id}`);
      captured.push({
        ...question,
        relevantIds: [],
        forbiddenIds: [],
        candidates: (response.facts || []).map(asCandidate),
        capture: {
          returnedFacts: response.facts?.length || 0,
          localReason: response.jev?.reason || 'not_run',
        },
      });
    }
  } finally {
    if (statusBefore.enabled) await daemonCall('settings.set', { updates: { 'jev.enabled': true } });
    statusAfter = await daemonCall('jev.status');
  }

  if (statusAfter.enabled !== statusBefore.enabled) throw new Error('Jev enabled state was not restored.');
  const corpus = {
    schemaVersion: 1,
    labelStatus: 'draft-unreviewed',
    generatedAt: new Date().toISOString(),
    source: {
      questionsPath,
      questionsSha256: createHash('sha256').update(questionsText).digest('hex'),
      candidateLimit: limit,
      localOnly: true,
    },
    cases: captured,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`);
  await writeFile(reviewPath, renderReview(corpus));

  console.log(`Captured ${captured.length} local baseline cases.`);
  console.log(`Corpus: ${outputPath}`);
  console.log(`Review sheet: ${reviewPath}`);
  console.log(`Jev restored: enabled=${statusAfter.enabled} configured=${statusAfter.configured} minScore=${statusAfter.minScore}`);
}

main()
  // daemonCall keeps its socket alive after all capture work is complete.
  // Exit only after files are flushed and the prior Jev state is verified.
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Corpus capture failed: ${error.message}`);
    process.exit(1);
  });
