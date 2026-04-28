import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from './parsers/index.js';
import { chunkSections } from './chunker.js';
import { embedBatch } from './embedder.js';
import { contextualizeChunks } from './contextualizer.js';
import * as documentStore from '../memory/documents/store.js';
import * as chunkStore from '../memory/chunks/store.js';
import { extractFactsFromChunks } from '../memory/facts/extractor.js';
import { saveFact } from '../memory/facts/store.js';
import { DEFAULT_CATEGORIES } from '../memory/facts/categories.js';
import { classifyInput } from '../memory/cognitive/input-classifier.js';
import { linkDocumentEntities } from '../memory/entities/linker.js';
import config from '../config.js';
import { PROMPTS_DIR } from '../lib/paths.js';

const DEFAULT_PROMPT_PATH = join(PROMPTS_DIR, 'default-extraction.md');

/**
 * Ingest a document into the Cortex knowledge base.
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
  entities,
  skipFacts = false,
  skipEntities = false,
  skipContextualization = false,
  classify = true,
}) {
  const ns = namespace || config.defaults.namespace;
  const cats = categories || Object.keys(DEFAULT_CATEGORIES);
  const prompt = promptPath || DEFAULT_PROMPT_PATH;
  let finalTitle = title || sourcePath;

  // Step 0: Classify input (cognitive layer)
  let classification = null;
  if (classify) {
    process.stderr.write('[0/6] Classifying input...' + "\n");
    classification = await classifyInput(content, { title: finalTitle });
    process.stderr.write(`  Route: ${classification.route} — ${classification.reasoning}` + "\n");

    if (classification.route === 'noise') {
      process.stderr.write('  Skipped — classified as noise.' + "\n");
      return { documentId: null, title: finalTitle, skipped: true, route: 'noise' };
    }
  }

  // Step 1: Hash for change detection (before parsing — skip early if unchanged)
  process.stderr.write('[1/6] Checking for changes...' + "\n");
  const contentHash = createHash('sha256').update(content).digest('hex');
  const effectiveSourcePath = sourcePath || `thought:${contentHash}`;
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

  // Step 2: Parse content into text + sections
  process.stderr.write('[2/6] Parsing content...' + "\n");
  const parsed = parse(content, { format: metadata.format, filePath: sourcePath, contentType });
  finalTitle = title || parsed.metadata?.title || sourcePath;

  // Thought fast-path: store facts directly, skip chunking/extraction
  if (classification?.route === 'thought' && classification.facts.length) {
    process.stderr.write(`[thought] Storing ${classification.facts.length} facts directly...` + "\n");
    const thoughtResult = await storeDirectFacts(classification.facts, {
      documentId: doc.id,
      namespace: ns,
    });

    let entityResult = { entityCount: 0, relationCount: 0, factEntityLinks: 0, topics: [] };
    if (!skipEntities && thoughtResult.results.length) {
      entityResult = await linkDocumentEntities(
        { title: finalTitle, sourceType, metadata },
        thoughtResult.results,
        ns,
        entities,
      );
    }

    await documentStore.updateCounts(doc.id, { chunkCount: 0, factCount: thoughtResult.counts.added });

    process.stderr.write(`Done. Route: thought, ${thoughtResult.counts.total} facts (${thoughtResult.counts.added} new)` + "\n");
    return {
      documentId: doc.id,
      documentUid: doc.uid,
      title: finalTitle,
      skipped: false,
      route: 'thought',
      chunkCount: 0,
      facts: thoughtResult.counts,
      entities: entityResult,
    };
  }

  let chunks = [];
  let factResult = { counts: { total: 0, added: 0, skipped: 0, updated: 0, contradicted: 0 }, results: [] };
  let entityResult = { entityCount: 0, relationCount: 0, factEntityLinks: 0, topics: [] };

  try {
    // Step 3: Chunk + contextualize + embed
    process.stderr.write('[3/6] Chunking and embedding...' + "\n");
    chunks = chunkSections(parsed.sections);
    process.stderr.write(`  ${chunks.length} chunks created` + "\n");

    if (!skipContextualization && chunks.length) {
      chunks = await contextualizeChunks(chunks, parsed.text, { title: finalTitle });
    }

    const texts = chunks.map((c) => {
      const prefix = c.contextualPrefix;
      return prefix ? `${prefix}\n${c.content}` : c.content;
    });
    const embeddings = await embedBatch(texts);

    const chunksWithEmbeddings = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i],
    }));

    await chunkStore.insertChunks(doc.id, chunksWithEmbeddings, ns);

    // Step 4: Extract facts per chunk
    if (!skipFacts) {
      process.stderr.write('[4/6] Extracting facts...' + "\n");
      factResult = await extractAndStoreFacts(chunks, {
        documentId: doc.id,
        namespace: ns,
        promptPath: prompt,
        categories: cats,
      });
    }

    await documentStore.updateCounts(doc.id, {
      chunkCount: chunks.length,
      factCount: factResult.counts.added + factResult.counts.updated + factResult.counts.contradicted,
    });

    // Step 5: Link entities
    if (!skipEntities && factResult.results.length) {
      process.stderr.write('[5/6] Linking entities...' + "\n");
      entityResult = await linkDocumentEntities({
        title: finalTitle,
        sourceType,
        metadata,
      }, factResult.results, ns, entities);
      process.stderr.write(`  ${entityResult.entityCount} entities, ${entityResult.relationCount} relations` + "\n");
    }

  } catch (err) {
    // Reset content hash so re-ingest doesn't skip this document
    console.error(`[pipeline] Failed after document upsert: ${err.message}`);
    await documentStore.resetHash(doc.id).catch(() => {});
    throw err;
  }

  process.stderr.write(`Done. ${chunks.length} chunks, ${factResult.counts.total} facts, ${entityResult.entityCount} entities` + "\n");

  return {
    documentId: doc.id,
    documentUid: doc.uid,
    title: finalTitle,
    skipped: false,
    chunkCount: chunks.length,
    facts: factResult.counts,
    entities: entityResult,
  };
}

async function storeFactsInBatches(facts, { documentId, namespace, embeddings, defaultConfidence = 'medium', defaultImportance = 'supplementary' }) {
  const counts = { total: facts.length, added: 0, skipped: 0, updated: 0, contradicted: 0 };
  const allResults = [];

  // Facts are stored sequentially to prevent AUDM race conditions.
  // Two similar facts processed in parallel could both pass findSimilar
  // before either is inserted, bypassing deduplication.
  for (let a = 0; a < facts.length; a++) {
    const raw = facts[a];
    const result = await saveFact({
      content: raw.content,
      category: raw.category,
      confidence: raw.confidence || defaultConfidence,
      importance: raw.importance || defaultImportance,
      namespace,
      sourceDocumentIds: documentId ? [documentId] : [],
      sourceSection: raw.sourceSection || raw.category,
      embedding: embeddings[a],
    });
    allResults.push(result);

    const action = result.action.toLowerCase();
    if (action === 'add') counts.added++;
    else if (action === 'skip') counts.skipped++;
    else if (action === 'update') counts.updated++;
    else if (action === 'contradict') counts.contradicted++;
  }

  return { counts, results: allResults };
}

async function storeDirectFacts(facts, { documentId, namespace }) {
  const embeddings = await embedBatch(facts.map((f) => f.content));
  return storeFactsInBatches(facts, { documentId, namespace, embeddings, defaultConfidence: 'high', defaultImportance: 'vital' });
}

async function extractAndStoreFacts(chunks, { documentId, namespace, promptPath, categories }) {
  const rawFacts = await extractFactsFromChunks(chunks, { promptPath, categories });
  process.stderr.write(`  ${rawFacts.length} facts extracted from ${chunks.length} chunks` + "\n");

  if (!rawFacts.length) {
    return { counts: { total: 0, added: 0, skipped: 0, updated: 0, contradicted: 0 }, results: [] };
  }

  const embeddings = await embedBatch(rawFacts.map((f) => f.content));
  return storeFactsInBatches(rawFacts, { documentId, namespace, embeddings });
}


export { ingestDocument };
