#!/usr/bin/env node

/**
 * Cortex Benchmark Suite
 *
 * Measures: ingestion throughput, search latency, search quality, AUDM accuracy.
 * Usage: node src/scripts/benchmark.js
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { config as dotenvConfig } from 'dotenv';
import { performance } from 'node:perf_hooks';

const home = process.env.HOME || process.env.USERPROFILE;
const globalEnv = join(home, '.cortex', '.env');
const localEnv = resolve(process.cwd(), '.env');
if (existsSync(localEnv)) dotenvConfig({ path: localEnv, quiet: true });
else if (existsSync(globalEnv)) dotenvConfig({ path: globalEnv, quiet: true });

const { ingestDocument } = await import('../ingestion/pipeline.js');
const { search } = await import('../memory/search/hybrid.js');
const { embed } = await import('../ingestion/embedder.js');
const { getFactCount } = await import('../memory/facts/store.js');
const { getStats } = await import('../memory/documents/store.js');
const config = (await import('../config.js')).default;
const cortexDb = (await import('../db/cortex.js')).default;

// ─── Test Corpus ────────────────────────────────────────────────────────────

const TEST_DOCUMENTS = [
  {
    title: 'Architecture Overview',
    content: `# Project Architecture

Our application uses a microservices architecture deployed on AWS ECS.
The frontend is built with Next.js 14 and deployed to Vercel.
The backend consists of three services: auth-service (Node.js/Express),
data-service (Python/FastAPI), and notification-service (Go).

All services communicate via RabbitMQ message queues.
PostgreSQL 16 is the primary database, with Redis for caching.
We use Prisma as the ORM for the auth and data services.

Authentication uses JWT tokens with 15-minute expiry and refresh token rotation.
The API gateway is Kong, handling rate limiting and request routing.`,
  },
  {
    title: 'Team Decisions Log',
    content: `# Technical Decisions — Q1 2026

## Database Migration
We migrated from MySQL 8 to PostgreSQL 16 in January 2026.
The primary reason was better JSON support and pgvector for AI features.
Migration took 3 weeks and was completed without data loss.

## Frontend Framework
We evaluated Remix, Next.js, and SvelteKit. Chose Next.js 14 because
the team already had experience with it and the App Router was stable.

## Testing Strategy
Unit tests use Vitest. Integration tests hit a real database (not mocks).
E2E tests use Playwright. Coverage target is 80% for critical paths.
We don't mock the database because we got burned by mock/prod divergence.`,
  },
  {
    title: 'API Documentation',
    content: `# REST API Reference

## Authentication
POST /api/auth/login — returns JWT access token and refresh token.
POST /api/auth/refresh — exchanges refresh token for new access token.
POST /api/auth/logout — invalidates the refresh token.

All authenticated endpoints require Bearer token in Authorization header.
Rate limit: 100 requests per minute per user, 1000 per minute per IP.

## Users
GET /api/users/:id — returns user profile (requires auth).
PATCH /api/users/:id — updates user profile (requires auth, own profile only).
DELETE /api/users/:id — soft deletes user (requires admin role).

## Projects
GET /api/projects — list user's projects (paginated, 20 per page).
POST /api/projects — create new project (requires auth).
GET /api/projects/:id — project detail with member list.`,
  },
  {
    title: 'Deployment Runbook',
    content: `# Deployment Process

## Production Deploys
1. Create PR against main branch
2. CI runs: lint, type check, unit tests, integration tests
3. Two approvals required from the team
4. Merge triggers auto-deploy to staging
5. QA verifies on staging (30-minute window)
6. Manual promotion to production via GitHub Actions
7. Canary deployment: 10% traffic for 15 minutes
8. Full rollout if no error spike

## Rollback
If error rate exceeds 2%, automatic rollback triggers.
Manual rollback: run the rollback GitHub Action with the previous tag.
Database rollbacks must be coordinated with the DBA team.

## Hotfix Process
Branch from the production tag, not main.
Skip staging but still requires one approval.
Deploy directly to production with full canary.`,
  },
  {
    title: 'Personal Preferences',
    content: `Some notes about how I like to work:

I prefer TypeScript over JavaScript for all new code.
Tab indentation, not spaces. 2-width tabs in config files.
I use Vim keybindings in VS Code.
Dark mode everything. Catppuccin Mocha theme.

For PRs: one logical change per PR, squash merge, conventional commits.
I don't like long-lived feature branches — merge to main at least daily.

For communication: async-first, write things down, avoid meetings when a
Slack thread would work. I check messages 3x daily, not continuously.`,
  },
];

// ─── Expected Search Results (Ground Truth) ─────────────────────────────────

const SEARCH_TESTS = [
  {
    query: 'what database do we use',
    expectedKeywords: ['PostgreSQL', '16'],
    description: 'Basic factual recall',
  },
  {
    query: 'how does authentication work',
    expectedKeywords: ['JWT', 'token', 'refresh'],
    description: 'Technical concept search',
  },
  {
    query: 'what frontend framework',
    expectedKeywords: ['Next.js', '14'],
    description: 'Decision recall',
  },
  {
    query: 'deployment process',
    expectedKeywords: ['staging', 'canary', 'rollback'],
    description: 'Process documentation search',
  },
  {
    query: 'testing strategy',
    expectedKeywords: ['Vitest', 'Playwright', 'mock'],
    description: 'Practice/convention search',
  },
  {
    query: 'what are my coding preferences',
    expectedKeywords: ['TypeScript', 'tab', 'dark mode'],
    description: 'Personal preference recall',
  },
  {
    query: 'how to rollback a deploy',
    expectedKeywords: ['rollback', 'GitHub Action', 'tag'],
    description: 'Procedural knowledge search',
  },
  {
    query: 'rate limiting',
    expectedKeywords: ['100', 'minute', 'rate'],
    description: 'Specific detail recall',
  },
  {
    query: 'why did we choose PostgreSQL',
    expectedKeywords: ['JSON', 'pgvector', 'MySQL'],
    description: 'Decision rationale search',
  },
  {
    query: 'message queue',
    expectedKeywords: ['RabbitMQ'],
    description: 'Infrastructure component search',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// ─── Benchmarks ─────────────────────────────────────────────────────────────

async function benchmarkEmbedding() {
  console.log('\n━━━ Embedding Latency ━━━');

  const texts = [
    'short query',
    'What database does the project use for the primary data store?',
    'A longer paragraph that contains multiple sentences about the architecture of the system, including details about the frontend framework, backend services, and deployment infrastructure used in production.',
  ];

  for (const text of texts) {
    const runs = 3;
    const times = [];

    for (let a = 0; a < runs; a++) {
      const start = performance.now();
      await embed(text);
      times.push(performance.now() - start);
    }

    const avg = times.reduce((s, t) => s + t, 0) / runs;
    const min = Math.min(...times);
    console.log(`  ${text.length} chars → avg ${formatMs(avg)}, min ${formatMs(min)}`);
  }
}

async function benchmarkIngestion() {
  console.log('\n━━━ Ingestion Throughput ━━━');

  const results = [];
  let totalFacts = 0;
  let totalChunks = 0;

  for (const doc of TEST_DOCUMENTS) {
    const start = performance.now();

    const result = await ingestDocument({
      content: doc.content,
      title: doc.title,
      sourcePath: `benchmark/${doc.title.toLowerCase().replace(/\s+/g, '-')}`,
      sourceType: 'benchmark',
      namespace: config.defaults.namespace,
      classify: false, // skip classifier for consistent benchmarks
    });

    const elapsed = performance.now() - start;

    const facts = result.facts?.added || 0;
    const chunks = result.chunkCount || 0;
    totalFacts += facts;
    totalChunks += chunks;

    results.push({ title: doc.title, elapsed, facts, chunks, skipped: result.skipped });
    console.log(`  ${doc.title}: ${formatMs(elapsed)} — ${chunks} chunks, ${facts} facts${result.skipped ? ' (skipped: unchanged)' : ''}`);
  }

  const totalTime = results.reduce((s, r) => s + r.elapsed, 0);
  console.log(`\n  Total: ${formatMs(totalTime)} for ${TEST_DOCUMENTS.length} docs, ${totalChunks} chunks, ${totalFacts} facts`);
  console.log(`  Throughput: ${(TEST_DOCUMENTS.length / (totalTime / 1000)).toFixed(1)} docs/sec`);

  return { totalTime, totalFacts, totalChunks };
}

async function benchmarkSearch() {
  console.log('\n━━━ Search Latency ━━━');

  const times = [];

  for (const test of SEARCH_TESTS) {
    const start = performance.now();
    await search(test.query, {
      namespaces: [config.defaults.namespace],
      limit: 5,
      useGraph: false,
      route: false,
      expand: false,
    });
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = [...times].sort((x, y) => x - y)[Math.floor(times.length / 2)];
  const p95 = [...times].sort((x, y) => x - y)[Math.floor(times.length * 0.95)];
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`  ${times.length} queries`);
  console.log(`  avg: ${formatMs(avg)}, p50: ${formatMs(p50)}, p95: ${formatMs(p95)}`);
  console.log(`  min: ${formatMs(min)}, max: ${formatMs(max)}`);

  return { avg, p50, p95, min, max };
}

async function benchmarkSearchQuality() {
  console.log('\n━━━ Search Quality (Recall@5) ━━━');

  let totalHits = 0;
  let totalExpected = 0;
  const results = [];

  for (const test of SEARCH_TESTS) {
    const { facts } = await search(test.query, {
      namespaces: [config.defaults.namespace],
      limit: 5,
      useGraph: false,
      route: false,
      expand: false,
    });

    const factText = facts.map((f) => f.content).join(' ').toLowerCase();
    const hits = test.expectedKeywords.filter((kw) => factText.toLowerCase().includes(kw.toLowerCase()));
    const recall = hits.length / test.expectedKeywords.length;

    totalHits += hits.length;
    totalExpected += test.expectedKeywords.length;

    const status = recall >= 0.5 ? '✓' : '✗';
    const missing = test.expectedKeywords.filter((kw) => !factText.toLowerCase().includes(kw.toLowerCase()));

    results.push({ query: test.query, recall, hits: hits.length, total: test.expectedKeywords.length, missing });
    console.log(`  ${status} ${test.description}: ${(recall * 100).toFixed(0)}% (${hits.length}/${test.expectedKeywords.length})${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  }

  const overallRecall = totalHits / totalExpected;
  console.log(`\n  Overall keyword recall: ${(overallRecall * 100).toFixed(1)}% (${totalHits}/${totalExpected})`);

  return { overallRecall, results };
}

async function benchmarkAUDM() {
  console.log('\n━━━ AUDM Deduplication ━━━');

  // Re-ingest the same documents — should all be skipped (content hash match)
  let skipped = 0;
  for (const doc of TEST_DOCUMENTS) {
    const result = await ingestDocument({
      content: doc.content,
      title: doc.title,
      sourcePath: `benchmark/${doc.title.toLowerCase().replace(/\s+/g, '-')}`,
      sourceType: 'benchmark',
      namespace: config.defaults.namespace,
      classify: false,
    });
    if (result.skipped) skipped++;
  }

  console.log(`  Re-ingestion: ${skipped}/${TEST_DOCUMENTS.length} correctly skipped (content hash match)`);

  // Test fact-level AUDM with a paraphrase
  const { saveFact } = await import('../memory/facts/store.js');
  const embedding = await embed('The application uses PostgreSQL version 16 as its main database');

  const result = await saveFact({
    content: 'The application uses PostgreSQL version 16 as its main database',
    category: 'architecture',
    confidence: 'high',
    importance: 'vital',
    namespace: config.defaults.namespace,
    sourceDocumentIds: [],
    sourceSection: 'benchmark',
    embedding,
  });

  console.log(`  Paraphrase test: "${result.action}" (expected: SKIP — similar fact exists)`);

  // Test with genuinely new fact
  const newEmbedding = await embed('The CI pipeline uses GitHub Actions with self-hosted runners on ARM64 Mac Minis');
  const newResult = await saveFact({
    content: 'The CI pipeline uses GitHub Actions with self-hosted runners on ARM64 Mac Minis',
    category: 'infrastructure',
    confidence: 'high',
    importance: 'supplementary',
    namespace: config.defaults.namespace,
    sourceDocumentIds: [],
    sourceSection: 'benchmark',
    embedding: newEmbedding,
  });

  console.log(`  New fact test: "${newResult.action}" (expected: ADD — genuinely new)`);

  return { skipped, paraphraseAction: result.action, newFactAction: newResult.action };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     Cortex Benchmark Suite           ║');
  console.log('╚══════════════════════════════════════╝');

  const ns = config.defaults.namespace;
  const statsBefore = await getStats(ns);
  const factsBefore = await getFactCount(ns);
  console.log(`\nKnowledge base: ${statsBefore.documentCount} docs, ${factsBefore} facts`);
  console.log(`LLM provider: ${config.llm.provider || 'auto-detect'}`);
  console.log(`Embedding: ${config.embedding.provider || 'auto-detect'} / ${config.embedding.model}`);

  const report = {};

  // 1. Embedding
  await benchmarkEmbedding();

  // 2. Ingestion
  report.ingestion = await benchmarkIngestion();

  // 3. Search latency
  report.searchLatency = await benchmarkSearch();

  // 4. Search quality
  report.searchQuality = await benchmarkSearchQuality();

  // 5. AUDM
  report.audm = await benchmarkAUDM();

  // Summary
  const statsAfter = await getStats(ns);
  const factsAfter = await getFactCount(ns);

  console.log('\n━━━ Summary ━━━');
  console.log(`  Documents: ${statsBefore.documentCount} → ${statsAfter.documentCount}`);
  console.log(`  Facts: ${factsBefore} → ${factsAfter}`);
  console.log(`  Ingestion: ${formatMs(report.ingestion.totalTime)} for ${TEST_DOCUMENTS.length} docs`);
  console.log(`  Search: avg ${formatMs(report.searchLatency.avg)}, p50 ${formatMs(report.searchLatency.p50)}`);
  console.log(`  Quality: ${(report.searchQuality.overallRecall * 100).toFixed(1)}% keyword recall@5`);
  console.log(`  AUDM: paraphrase=${report.audm.paraphraseAction}, new=${report.audm.newFactAction}`);

  // Write JSON report for dashboard
  const jsonReport = {
    timestamp: new Date().toISOString(),
    config: {
      llmProvider: config.llm.provider || 'auto-detect',
      embeddingProvider: config.embedding.provider || 'auto-detect',
      embeddingModel: config.embedding.model,
    },
    knowledgeBase: {
      documentsBefore: statsBefore.documentCount,
      documentsAfter: statsAfter.documentCount,
      factsBefore,
      factsAfter,
    },
    ingestion: {
      totalTimeMs: Math.round(report.ingestion.totalTime),
      documents: TEST_DOCUMENTS.length,
      chunks: report.ingestion.totalChunks,
      factsExtracted: report.ingestion.totalFacts,
      avgPerDocMs: Math.round(report.ingestion.totalTime / TEST_DOCUMENTS.length),
    },
    search: {
      avgMs: Math.round(report.searchLatency.avg),
      p50Ms: Math.round(report.searchLatency.p50),
      p95Ms: Math.round(report.searchLatency.p95),
      minMs: Math.round(report.searchLatency.min),
      maxMs: Math.round(report.searchLatency.max),
      queries: SEARCH_TESTS.length,
    },
    quality: {
      overallRecall: Math.round(report.searchQuality.overallRecall * 1000) / 10,
      tests: report.searchQuality.results.map((r) => ({
        query: r.query,
        recall: Math.round(r.recall * 100),
        hits: r.hits,
        total: r.total,
        missing: r.missing,
      })),
    },
    audm: {
      reingestionSkipped: `${report.audm.skipped}/${TEST_DOCUMENTS.length}`,
      paraphraseAction: report.audm.paraphraseAction,
      newFactAction: report.audm.newFactAction,
    },
  };

  const reportPath = join(dirname(fileURLToPath(import.meta.url)), '../../benchmark-report.json');
  await writeFile(reportPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\n  Report saved to benchmark-report.json`);

  await cortexDb.destroy();
}

run().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
