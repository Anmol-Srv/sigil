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
import { saveFact, supersedeStaleDocFacts } from '../memory/facts/store.js';
import { DEFAULT_CATEGORIES } from '../memory/facts/categories.js';
import { classifyInput } from '../memory/cognitive/input-classifier.js';
import { linkDocumentEntities } from '../memory/entities/linker.js';
import * as podStore from '../memory/pods/store.js';
import * as podMembership from '../memory/pods/membership.js';
import { fromSourceMetadata as resolvePodsFromMetadata } from '../memory/pods/resolver.js';
import { maskSecrets } from '../hooks/secret-mask.js';
import config from '../config.js';
import { PROMPTS_DIR } from '../lib/paths.js';

const DEFAULT_PROMPT_PATH = join(PROMPTS_DIR, 'default-extraction.md');

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
  entities,
  skipFacts = false,
  skipEntities = false,
  skipContextualization = false,
  classify = true,
  // Pod attachment. `podUids` is an explicit list (used by hooks to attach
  // to the active session pod). `resolvePodsFrom: 'metadata'` triggers
  // connector-derived attachment from the metadata payload (workspace
  // pods, sender person pods). Both default to off so legacy callers are
  // unchanged.
  podUids = [],
  resolvePodsFrom = null,
}) {
  // Symmetric secret masking. Read-side masking already runs in the hook
  // before injection; mask here at the single ingest choke point so secrets
  // never reach the embedding API or get stored. This is BEFORE classify,
  // parse, chunk, embed, and fact extraction (including the thought-route
  // facts the classifier produces from raw content) so every downstream copy
  // — chunk embeddings, extracted facts, stored content — is masked.
  // Trade-off: the classifier sees masked content; acceptable, since for a
  // secret-bearing input the literal secret never improves routing and
  // preventing exfiltration outranks classifier fidelity. Idempotent.
  content = maskSecrets(content);

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

  // Persist the metadata payload now that the document row exists.
  // Connector ingest carries source_metadata.connection_id for the FK;
  // explicit hook callers usually don't.
  if (metadata && (Object.keys(metadata).length || metadata.connection_id)) {
    await documentStore.updateSourceMetadata(doc.id, metadata, metadata.connection_id ?? null);
  }

  // Resolve the set of pods this document (and its descendant facts) should
  // attach to. Two sources are merged: explicit uids passed in by callers
  // (hooks → active session pod) and connector-derived attachments from
  // source_metadata. Both are no-ops when the inputs are empty.
  const podAttachments = await resolvePodAttachments({ podUids, resolvePodsFrom, metadata, namespace: ns });
  for (const { podId, role } of podAttachments) {
    await podMembership.attachDocument(podId, doc.id, role);
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

    // Mirror the document's pod attachments down to its facts so a session
    // pod query surfaces the actual fact rows, not just the document.
    await attachFactsToPods(thoughtResult.results, podAttachments);

    // Re-ingest hygiene: retire facts from this doc's PRIOR content that the
    // new content no longer supports (no-op on first ingest — the just-saved
    // facts are excluded via keptFactIds).
    await supersedeStaleDocFacts(
      doc.id,
      thoughtResult.results.map((r) => r.fact?.id ?? r.existing?.id).filter(Boolean),
    );

    process.stderr.write(`Done. Route: thought, ${thoughtResult.counts.total} facts (${thoughtResult.counts.added} new)` + "\n");
    return {
      documentId: doc.id,
      documentUid: doc.uid,
      title: finalTitle,
      skipped: false,
      route: 'thought',
      chunkCount: 0,
      facts: { ...thoughtResult.counts, verdicts: traceVerdicts(thoughtResult.results) },
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

    // Step 4: Extract facts per chunk — skipped in lazy mode (Ogham approach: store raw,
    // let read-time synthesis compose answers from chunks instead).
    if (!skipFacts && config.ingest.eagerExtract) {
      process.stderr.write('[4/6] Extracting facts...' + "\n");
      factResult = await extractAndStoreFacts(chunks, {
        documentId: doc.id,
        namespace: ns,
        promptPath: prompt,
        categories: cats,
      });
    } else if (!config.ingest.eagerExtract) {
      process.stderr.write('[4/6] Skipping fact extraction (SIGIL_EAGER_EXTRACT=false)' + "\n");
    }

    await documentStore.updateCounts(doc.id, {
      chunkCount: chunks.length,
      factCount: factResult.counts.added + factResult.counts.updated + factResult.counts.contradicted,
    });

    // Mirror the document's pod attachments down to its facts.
    await attachFactsToPods(factResult.results, podAttachments);

    // Re-ingest hygiene: supersede facts from this doc's PRIOR content that
    // the new content no longer re-confirms (no-op on first ingest).
    await supersedeStaleDocFacts(
      doc.id,
      factResult.results.map((r) => r.fact?.id ?? r.existing?.id).filter(Boolean),
    );

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
    route: classification?.route ?? null,
    chunkCount: chunks.length,
    facts: { ...factResult.counts, verdicts: traceVerdicts(factResult.results) },
    entities: entityResult,
  };
}

// Compact per-fact AUDM verdicts for the trace log: the action taken, the
// fact text, and the similarity/decision telemetry from saveFact().
function traceVerdicts(results) {
  return (results || []).map((r) => ({
    action: r.action,
    factId: r.fact?.id ?? r.existing?.id ?? null,
    content: String(r.fact?.content || r.existing?.content || '').slice(0, 240),
    audm: r.audm || null,
    supersededId: r.supersededId ?? null,
    contradictedId: r.contradictedId ?? null,
  }));
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

// Resolve the union of pod IDs this document should attach to. Two sources:
//   - explicit `podUids` (hooks pass the active session pod)
//   - connector-derived from `metadata` (workspace pods, etc.)
// Returns [{ podId, role }] suitable for batch-attach.
async function resolvePodAttachments({ podUids, resolvePodsFrom, metadata, namespace }) {
  const attachments = [];

  for (const uid of podUids) {
    const pod = await podStore.findByUid(uid);
    if (pod) attachments.push({ podId: pod.id, role: 'primary' });
  }

  if (resolvePodsFrom === 'metadata') {
    const derived = await resolvePodsFromMetadata(metadata, namespace);
    for (const a of derived) attachments.push(a);
  }

  // Dedup on podId (favouring 'primary' role when duplicated).
  const seen = new Map();
  for (const a of attachments) {
    const existing = seen.get(a.podId);
    if (!existing || (a.role === 'primary' && existing.role !== 'primary')) {
      seen.set(a.podId, a);
    }
  }
  return [...seen.values()];
}

// Attach the facts that descended from this document to its pod set.
// saveFact returns one of:
//   { action: 'ADD'|'UPDATE'|'CONTRADICT', fact: {...} }
//   { action: 'SKIP', existing: {...} }
// We treat SKIP as a re-mention worth recording in the pod too — the
// fact is still part of "what was discussed in this session/workspace",
// even if the storage layer collapsed it as a duplicate.
async function attachFactsToPods(results, attachments) {
  if (!attachments.length || !results.length) return;

  for (const r of results) {
    const factId = r?.fact?.id ?? r?.existing?.id;
    if (!factId) continue;
    const role = r?.action === 'SKIP' ? 'mention' : 'primary';
    for (const { podId } of attachments) {
      await podMembership.attachFact(podId, factId, role);
    }
  }
}


export { ingestDocument };
