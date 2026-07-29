import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parse } from './parsers/index.js';
import { chunkSections } from './chunker.js';
import { embedBatchOrThrow } from './embedder.js';
import * as documentStore from '../memory/documents/store.js';
import * as chunkStore from '../memory/chunks/store.js';
import { saveFactDeterministic, supersedeStaleDocFacts } from '../memory/facts/store.js';
import { DEFAULT_CATEGORIES } from '../memory/facts/categories.js';
import cortexDb from '../db/cortex.js';
import { maskSecrets } from '../hooks/secret-mask.js';
import config from '../config.js';
import { getConfig } from '../setup/config-store.js';
import { PROMPTS_DIR } from '../lib/paths.js';

const DEFAULT_PROMPT_PATH = join(PROMPTS_DIR, 'default-extraction.md');

// Refuse to ingest when setup never finished the Embeddings step. Without a
// working embedder, chunks/facts get no vector — the write either fails deep in
// the pipeline (dimension mismatch / model-not-found) or, worse, looks like it
// succeeded while nothing persists. Failing loudly here turns silent data loss
// into an actionable error.
//
// Only blocks when the setup wizard recorded an embedding step that isn't
// 'done'. Users who configured Sigil purely via env vars have no setup.steps,
// so they're never blocked by this.
function assertEmbeddingReady() {
  const step = getConfig().setup?.steps?.embedding;
  if (step && step !== 'done') {
    const err = new Error(
      `Sigil setup is incomplete — the Embeddings step is "${step}", so facts can't be `
      + 'embedded or saved. Finish setup with `sigil init` (Ollama: run '
      + '`ollama pull mxbai-embed-large` first), then retry.',
    );
    err.code = 'setup_incomplete';
    throw err;
  }
}

/**
 * Ingest a document into the Sigil knowledge base.
 *
 * This is the single public API for ingestion. All sources (file, URL, raw)
 * produce a source object that gets passed here.
 */
async function ingestDocument({
  content,
  title,
  sourcePath,
  sourceType = 'raw',
  contentType,
  namespace,
  metadata = {},
  promptPath,
  categories,
  skipFacts = false,
  extractFacts = config.ingest.eagerExtract,
}) {
  // Gate first: never start a write the embedder can't finish (silent-loss guard).
  assertEmbeddingReady();

  // Mask before parsing, embedding, extraction, or storage so secrets never
  // cross a provider boundary. Idempotent for already-masked content.
  content = maskSecrets(content);

  const ns = namespace || config.defaults.namespace;
  const cats = categories || Object.keys(DEFAULT_CATEGORIES);
  const prompt = promptPath || DEFAULT_PROMPT_PATH;
  const shouldExtractFacts = Boolean(extractFacts) && !skipFacts;
  let finalTitle = title || sourcePath;

  // Step 1: deterministic hash change detection; skip provider work if unchanged.
  process.stderr.write('[1/4] Checking for changes...' + "\n");
  const contentHash = createHash('sha256').update(content).digest('hex');
  const effectiveSourcePath = sourcePath || `raw:${contentHash}`;
  const { doc, changed } = await documentStore.upsert({
    sourcePath: effectiveSourcePath,
    sourceType,
    title: finalTitle,
    contentHash,
    namespace: ns,
  });

  if (!changed) {
    process.stderr.write('  Skipped — content unchanged.' + "\n");
    return { documentId: doc.id, title: finalTitle, skipped: true };
  }

  if (metadata && Object.keys(metadata).length) {
    await documentStore.updateSourceMetadata(doc.id, metadata);
  }

  // Step 2: Parse content into text + sections.
  process.stderr.write('[2/4] Parsing content...' + "\n");
  const parsed = parse(content, { format: metadata.format, filePath: sourcePath, contentType });
  finalTitle = title || parsed.metadata?.title || sourcePath;

  let chunks = [];
  let factResult = { counts: { total: 0, added: 0, skipped: 0 }, results: [] };

  try {
    // Step 3: deterministic chunking + one embedding batch. Contextual
    // generation added latency and another failure point without proven value.
    process.stderr.write('[3/4] Chunking and embedding...' + "\n");
    chunks = chunkSections(parsed.sections);
    process.stderr.write(`  ${chunks.length} chunks created` + "\n");
    const embeddings = await embedBatchOrThrow(chunks.map((chunk) => chunk.content));

    const chunksWithEmbeddings = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i],
    }));

    // Step 4: Extract facts (LLM) + embed them — done OUTSIDE the transaction
    // so a pooled DB connection isn't held across multi-second LLM/embed calls.
    let rawFacts = [];
    let factEmbeddings = [];
    if (shouldExtractFacts) {
      process.stderr.write('[4/4] Extracting facts (optional)...' + "\n");
      const { extractFactsFromChunks } = await import('../memory/facts/extractor.js');
      rawFacts = await extractFactsFromChunks(chunks, { promptPath: prompt, categories: cats });
      process.stderr.write(`  ${rawFacts.length} facts extracted from ${chunks.length} chunks` + "\n");
      if (rawFacts.length) factEmbeddings = await embedBatchOrThrow(rawFacts.map((f) => f.content));
    } else {
      process.stderr.write('[4/4] Fact extraction disabled; chunks are searchable as-is.' + "\n");
    }

    // ATOMIC write region. All provider work is already finished. Extracted
    // facts use deterministic duplicate suppression; no LLM runs in the
    // transaction and corrections are never inferred.
    await cortexDb.transaction(async (trx) => {
      await chunkStore.insertChunks(doc.id, chunksWithEmbeddings, ns, trx);
      if (rawFacts.length) {
        factResult = await storeFactsInBatches(rawFacts, {
          documentId: doc.id, namespace: ns, embeddings: factEmbeddings, db: trx,
        });
      }
      // Only retire previously extracted facts after a successful extraction
      // pass. A chunks-only re-ingest must not erase earlier facts merely
      // because generation is now disabled.
      if (shouldExtractFacts) {
        await supersedeStaleDocFacts(
          doc.id,
          factResult.results.map((r) => r.fact?.id ?? r.existing?.id).filter(Boolean),
          trx,
        );
      }
    });

    // Preserve the prior fact count when this was a chunks-only ingest.
    await documentStore.updateCounts(doc.id, {
      chunkCount: chunks.length,
      ...(shouldExtractFacts ? { factCount: factResult.counts.added } : {}),
    });

  } catch (err) {
    // Reset content hash so re-ingest doesn't skip this document. The
    // transaction already rolled back any partial chunk/fact writes, so there
    // is no orphaned state to clean up — just allow a clean retry.
    console.error(`[pipeline] Failed after document upsert: ${err.message}`);
    await documentStore.resetHash(doc.id).catch(() => {});
    throw err;
  }

  process.stderr.write(`Done. ${chunks.length} chunks, ${factResult.counts.total} extracted facts` + "\n");

  return {
    documentId: doc.id,
    documentUid: doc.uid,
    title: finalTitle,
    skipped: false,
    route: 'document',
    chunkCount: chunks.length,
    facts: { ...factResult.counts, verdicts: traceVerdicts(factResult.results) },
  };
}

// Compact deterministic write results for the trace log.
function traceVerdicts(results) {
  return (results || []).map((r) => ({
    action: r.action,
    factId: r.fact?.id ?? r.existing?.id ?? null,
    content: String(r.fact?.content || r.existing?.content || '').slice(0, 240),
    dedup: r.dedup || null,
  }));
}

async function storeFactsInBatches(facts, { documentId, namespace, embeddings, defaultConfidence = 'medium', defaultImportance = 'supplementary', db } = {}) {
  const counts = { total: facts.length, added: 0, skipped: 0 };
  const allResults = [];

  // Facts are stored sequentially so within-batch duplicate checks see facts
  // inserted earlier in the same transaction.
  for (let a = 0; a < facts.length; a++) {
    const raw = facts[a];
    const result = await saveFactDeterministic({
      content: raw.content,
      category: raw.category,
      confidence: raw.confidence || defaultConfidence,
      importance: raw.importance || defaultImportance,
      namespace,
      sourceDocumentIds: documentId ? [documentId] : [],
      sourceSection: raw.sourceSection || raw.category,
      embedding: embeddings[a],
    }, db);
    allResults.push(result);

    const action = result.action.toLowerCase();
    if (action === 'add') counts.added++;
    else if (action === 'skip') counts.skipped++;
  }

  return { counts, results: allResults };
}


export { ingestDocument };
