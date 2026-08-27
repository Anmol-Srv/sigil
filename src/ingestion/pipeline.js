import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parse } from './parsers/index.js';
import { chunkSections } from './chunker.js';
import { embedBatchOrThrow } from './embedder.js';
import { contextualizeChunks } from './contextualizer.js';
import * as documentStore from '../memory/documents/store.js';
import * as chunkStore from '../memory/chunks/store.js';
import { extractFactsFromChunks } from '../memory/facts/extractor.js';
import {
  prepareFactBatch,
  applyPreparedFactBatch,
  supersedeStaleDocFacts,
  countActiveByDocuments,
} from '../memory/facts/store.js';
import { DEFAULT_CATEGORIES, PERSONAL_CATEGORIES } from '../memory/facts/categories.js';
import { classifyInput } from '../memory/cognitive/input-classifier.js';
import { linkDocumentEntities } from '../memory/entities/linker.js';
import * as podStore from '../memory/pods/store.js';
import * as podMembership from '../memory/pods/membership.js';
import cortexDb from '../db/cortex.js';
import { fromSourceMetadata as resolvePodsFromMetadata } from '../memory/pods/resolver.js';
import { maskSecrets } from '../hooks/secret-mask.js';
import config from '../config.js';
import { getConfig } from '../setup/config-store.js';
import { PROMPTS_DIR } from '../lib/paths.js';
import { withWriteLock } from '../daemon/write-queue.js';
import { queueEntityEnrichment, kickIngestionJobRunner } from './jobs/runner.js';

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
  entities,
  skipFacts = false,
  skipEntities = false,
  // Core ingestion ends once chunks/facts are searchable. Entity and relation
  // work is a durable follow-up job by default; diagnostics/tests can opt into
  // synchronous enrichment explicitly.
  deferEntities = true,
  // Durable-job retries use this after an interrupted attempt may already have
  // admitted the content hash. Reprocessing is idempotent: chunks replace the
  // prior set and facts exact-dedupe at commit.
  force = false,
  skipContextualization = false,
  classify = true,
  // The caller guarantees `content` is ONE short, self-contained fact, so the
  // knowledge route (chunk → contextualize → extract) cannot apply. `remember`
  // sets this: it already rejects document-shaped input, so what arrives is a
  // fact by construction. Worth ~2 LLM calls per save. See classifyInput.
  atomic = false,
  // Pod attachment. `podUids` is an explicit list (used by hooks to attach
  // to the active session pod). `resolvePodsFrom: 'metadata'` triggers
  // connector-derived attachment from the metadata payload (workspace
  // pods, sender person pods). Both default to off so legacy callers are
  // unchanged.
  podUids = [],
  resolvePodsFrom = null,
}) {
  // Gate first: never start a write the embedder can't finish (silent-loss guard).
  assertEmbeddingReady();

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
    classification = await classifyInput(content, { title: finalTitle, atomic });
    process.stderr.write(`  Route: ${classification.route} — ${classification.reasoning}` + "\n");

    if (classification.route === 'noise') {
      process.stderr.write('  Skipped — classified as noise.' + "\n");
      return { documentId: null, title: finalTitle, skipped: true, route: 'noise' };
    }
  } else if (atomic) {
    // The caller already produced one durable fact (Stop hook, spool replay,
    // explicit atomic API). Re-running a classifier or sending it through the
    // document extractor is both redundant and slow; preserve it verbatim.
    classification = {
      route: 'thought',
      facts: [{
        content: content.trim(),
        category: 'domain_knowledge',
        confidence: 'high',
        importance: 'supplementary',
      }],
      entities: [],
      reasoning: 'Caller asserted atomic fact',
    };
  }

  // Step 1: Hash for change detection (before parsing — skip early if unchanged)
  process.stderr.write('[1/6] Checking for changes...' + "\n");
  const contentHash = createHash('sha256').update(content).digest('hex');
  const effectiveSourcePath = sourcePath || `thought:${contentHash}`;
  // Admission is the first short write section. The old daemon-wide handler
  // lock wrapped classification, extraction and graph inference too; placing
  // the lock at the actual mutation boundary lets other ingests prepare in
  // parallel while PGlite still sees one writer at a time.
  const admitted = await withWriteLock(async () => {
    const upserted = await documentStore.upsert({
      sourcePath: effectiveSourcePath,
      sourceType,
      title: finalTitle,
      contentHash,
      namespace: ns,
      // Keep the original text on the row so the document can be handed back
      // whole later. Chunks alone can't do that: they overlap at every seam.
      content,
    });

    const incomplete = !upserted.changed
      && upserted.doc.chunkCount === 0
      && upserted.doc.factCount === 0;
    if (!upserted.changed && !force && !incomplete) return { ...upserted, podAttachments: [] };

    // Persist metadata + pod membership as part of admission. These are short
    // indexed writes; no model/provider work is allowed in this section.
    if (metadata && (Object.keys(metadata).length || metadata.connection_id)) {
      await documentStore.updateSourceMetadata(upserted.doc.id, metadata, metadata.connection_id ?? null);
    }
    const attachments = await resolvePodAttachments({ podUids, resolvePodsFrom, metadata, namespace: ns });
    for (const { podId, role } of attachments) {
      await podMembership.attachDocument(podId, upserted.doc.id, role);
    }
    return { ...upserted, changed: true, podAttachments: attachments };
  });
  const { doc, changed, podAttachments } = admitted;

  if (!changed) {
    process.stderr.write('  Skipped — content unchanged.' + "\n");
    return { documentId: doc.id, documentUid: doc.uid, title: finalTitle, skipped: true };
  }

  // Step 2: Parse content into text + sections
  process.stderr.write('[2/6] Parsing content...' + "\n");
  const parsed = parse(content, { format: metadata.format, filePath: sourcePath, contentType });
  finalTitle = title || parsed.metadata?.title || sourcePath;

  // Thought fast-path: store facts directly, skip chunking/extraction
  if (classification?.route === 'thought' && classification.facts.length) {
    process.stderr.write(`[thought] Storing ${classification.facts.length} facts directly...` + "\n");
    try {

    // Embed OUTSIDE the tx; then store facts + pod-attach + supersede atomically.
    const thoughtEmbeddings = await embedBatchOrThrow(classification.facts.map((f) => f.content));
    const preparedThoughts = await prepareFactBatch(buildFactSpecs(classification.facts, {
      documentId: doc.id,
      namespace: ns,
      embeddings: thoughtEmbeddings,
      defaultConfidence: 'high',
      defaultImportance: 'supplementary',
    }));
    let thoughtResult = { counts: emptyFactCounts(), results: [] };
    let stagedEntityJob = null;
    await withWriteLock(() => cortexDb.transaction(async (trx) => {
      const results = await applyPreparedFactBatch(preparedThoughts, { db: trx });
      thoughtResult = summarizeFactResults(results);
      // Mirror the document's pod attachments down to its facts so a session
      // pod query surfaces the actual fact rows, not just the document.
      await attachFactsToPods(thoughtResult.results, podAttachments, trx);
      // Re-ingest hygiene: retire facts from this doc's PRIOR content the new
      // content no longer supports (no-op on first ingest).
      await supersedeStaleDocFacts(
        doc.id,
        thoughtResult.results.map((r) => r.fact?.id ?? r.existing?.id).filter(Boolean),
        trx,
      );
      const activeCounts = await countActiveByDocuments([doc.id], trx);
      await documentStore.updateCounts(doc.id, { chunkCount: 0, factCount: activeCounts.get(Number(doc.id)) || 0 }, trx);
      if (!skipEntities && deferEntities && thoughtResult.results.length) {
        stagedEntityJob = await queueEntityEnrichment({
          documentId: doc.id, namespace: ns, title: finalTitle,
          sourceType, metadata, entities,
        }, trx);
      }
    }));

    // Entities AFTER commit — additive graph enrichment, must not roll back facts.
    let entityResult = { entityCount: 0, relationCount: 0, factEntityLinks: 0, topics: [] };
    if (!skipEntities && thoughtResult.results.length) {
      if (deferEntities) {
        kickIngestionJobRunner();
        entityResult = queuedEntityResult(stagedEntityJob);
      } else try {
        entityResult = await linkDocumentEntities(
          { title: finalTitle, sourceType, metadata },
          thoughtResult.results,
          ns,
          entities,
        );
      } catch (err) {
        process.stderr.write(`[thought] entity linking failed (facts preserved): ${err.message}` + "\n");
      }
    }

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
    } catch (err) {
      // A changed source may still have the previous version's non-zero fact
      // count. Reset the newly-admitted hash so that retry cannot mistake that
      // older completed version for this failed one.
      await documentStore.resetHash(doc.id).catch(() => {});
      throw err;
    }
  }

  let chunks = [];
  let factResult = { counts: { total: 0, added: 0, skipped: 0, updated: 0, contradicted: 0 }, results: [] };
  let entityResult = { entityCount: 0, relationCount: 0, factEntityLinks: 0, topics: [] };
  let stagedEntityJob = null;

  try {
    // Step 3: Chunk + contextualize + embed
    process.stderr.write('[3/6] Chunking and embedding...' + "\n");
    chunks = chunkSections(parsed.sections);
    process.stderr.write(`  ${chunks.length} chunks created` + "\n");

    // Context prefixes and fact extraction both read the same raw chunks and do
    // not depend on each other. Run the two model calls together; then batch the
    // two independent embedding sets together as well.
    const contextualizePromise = !skipContextualization && chunks.length
      ? contextualizeChunks(chunks, parsed.text, { title: finalTitle })
      : Promise.resolve(chunks);
    let extractPromise = Promise.resolve([]);
    if (!skipFacts && config.ingest.eagerExtract) {
      process.stderr.write('[4/6] Extracting facts...' + "\n");
      extractPromise = extractFactsFromChunks(chunks, { promptPath: prompt, categories: cats });
    } else if (!config.ingest.eagerExtract) {
      process.stderr.write('[4/6] Skipping fact extraction (SIGIL_EAGER_EXTRACT=false)' + "\n");
    }

    let rawFacts;
    [chunks, rawFacts] = await Promise.all([contextualizePromise, extractPromise]);
    if (!skipFacts && config.ingest.eagerExtract) {
      process.stderr.write(`  ${rawFacts.length} facts extracted from ${chunks.length} chunks` + "\n");
    }

    const texts = chunks.map((c) => c.contextualPrefix ? `${c.contextualPrefix}\n${c.content}` : c.content);
    const [embeddings, factEmbeddings] = await Promise.all([
      embedBatchOrThrow(texts),
      rawFacts.length ? embedBatchOrThrow(rawFacts.map((f) => f.content)) : Promise.resolve([]),
    ]);
    const chunksWithEmbeddings = chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));

    // AUDM preparation (ANN reads + at most one batched judge call) remains
    // outside the transaction.
    let preparedFacts = [];
    if (rawFacts.length) {
      preparedFacts = await prepareFactBatch(buildFactSpecs(rawFacts, {
        documentId: doc.id,
        namespace: ns,
        embeddings: factEmbeddings,
      }));
    }

    // ATOMIC write region: SQL only. Chunks + prepared fact verdicts + pod
    // attachment + stale retirement commit together; every model and embedding
    // call finished before this lock was acquired.
    await withWriteLock(() => cortexDb.transaction(async (trx) => {
      await chunkStore.insertChunks(doc.id, chunksWithEmbeddings, ns, trx);
      if (preparedFacts.length) {
        const results = await applyPreparedFactBatch(preparedFacts, { db: trx });
        factResult = summarizeFactResults(results);
      }
      // Mirror the document's pod attachments down to its facts — inside the tx
      // so a fact and its pod membership commit atomically (no invisible-to-
      // scoped-search facts).
      await attachFactsToPods(factResult.results, podAttachments, trx);
      // Re-ingest hygiene: supersede facts from this doc's PRIOR content the
      // new content no longer re-confirms (no-op on first ingest).
      await supersedeStaleDocFacts(
        doc.id,
        factResult.results.map((r) => r.fact?.id ?? r.existing?.id).filter(Boolean),
        trx,
      );
      const activeCounts = await countActiveByDocuments([doc.id], trx);
      await documentStore.updateCounts(doc.id, {
        chunkCount: chunks.length,
        factCount: activeCounts.get(Number(doc.id)) || 0,
      }, trx);
      if (!skipEntities && deferEntities && factResult.results.length) {
        stagedEntityJob = await queueEntityEnrichment({
          documentId: doc.id, namespace: ns, title: finalTitle,
          sourceType, metadata, entities,
        }, trx);
      }
    }));

    // Step 5: Link entities — graph enrichment, AFTER facts are durably
    // committed. A linking failure must not roll back valid facts, so it's
    // caught here: the facts are already committed and a partial graph is fine.
    if (!skipEntities && factResult.results.length) {
      process.stderr.write('[5/6] Linking entities...' + "\n");
      if (deferEntities) {
        kickIngestionJobRunner();
        entityResult = queuedEntityResult(stagedEntityJob);
        process.stderr.write(`  Entity enrichment queued${entityResult.jobUid ? ` (${entityResult.jobUid})` : ''}` + "\n");
      } else try {
        entityResult = await linkDocumentEntities({
          title: finalTitle,
          sourceType,
          metadata,
        }, factResult.results, ns, entities);
        process.stderr.write(`  ${entityResult.entityCount} entities, ${entityResult.relationCount} relations` + "\n");

      } catch (err) {
        process.stderr.write(`  [5/6] entity linking failed (facts preserved): ${err.message}` + "\n");
      }
    }

  } catch (err) {
    // Reset content hash so re-ingest doesn't skip this document. The
    // transaction already rolled back any partial chunk/fact writes, so there
    // is no orphaned state to clean up — just allow a clean retry.
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

/**
 * Fast lane for explicit atomic memories (`remember` and classified Stop-hook
 * facts). The caller already decided these strings are durable facts, so there
 * is no classifier, chunker, contextualizer, extractor, or synchronous graph
 * work. All embeddings and AUDM comparisons are batched; SQL is confined to
 * admission and one commit transaction.
 */
async function ingestAtomicFacts({ facts, namespace, podUids = [] }) {
  assertEmbeddingReady();
  const ns = namespace || config.defaults.namespace;
  const sourceFacts = Array.isArray(facts) ? facts : [];
  const inputs = sourceFacts
    .map((content, originalIndex) => ({
      content: maskSecrets(String(content || '').trim()),
      originalIndex,
    }))
    .filter((input) => Boolean(input.content))
    .map(({ content, originalIndex }) => ({
      content,
      originalIndex,
      category: inferAtomicCategory(content),
      confidence: 'high',
      importance: 'supplementary',
    }));
  if (!inputs.length) {
    return {
      counts: { ...emptyFactCounts(sourceFacts.length), skipped: sourceFacts.length },
      results: sourceFacts.map(() => ({ action: 'SKIP_EMPTY' })),
      documents: [],
    };
  }

  // Pod lookup is read-only and must not wait behind an unrelated writer.
  const attachments = await resolvePodAttachments({
    podUids,
    resolvePodsFrom: null,
    metadata: {},
    namespace: ns,
  });

  const admissions = await withWriteLock(async () => {
    const rows = [];
    for (const input of inputs) {
      const contentHash = createHash('sha256').update(input.content).digest('hex');
      const admitted = await documentStore.upsert({
        sourcePath: `thought:${contentHash}`,
        sourceType: 'raw',
        title: null,
        contentHash,
        namespace: ns,
        content: input.content,
      });
      const changed = admitted.changed || (!admitted.changed && admitted.doc.factCount === 0);
      if (changed) {
        for (const { podId, role } of attachments) {
          await podMembership.attachDocument(podId, admitted.doc.id, role);
        }
      }
      rows.push({ ...admitted, changed, input, contentHash });
    }
    return rows;
  });

  const changed = admissions.filter((a) => a.changed);
  if (!changed.length) {
    const results = sourceFacts.map(() => ({ action: 'SKIP_EMPTY' }));
    for (const admission of admissions) {
      results[admission.input.originalIndex] = {
        action: 'SKIP_DOCUMENT',
        document: admission.doc,
      };
    }
    return {
      counts: { ...emptyFactCounts(sourceFacts.length), skipped: sourceFacts.length },
      results,
      documents: admissions.map((a) => a.doc),
    };
  }

  try {
    const embeddings = await embedBatchOrThrow(changed.map((a) => a.input.content));
    const specs = changed.map((a, index) => ({
      ...a.input,
      namespace: ns,
      sourceDocumentIds: [a.doc.id],
      sourceSection: a.input.category,
      embedding: embeddings[index],
    }));
    const prepared = await prepareFactBatch(specs);
    let stored = [];
    let stagedEntityJob = null;
    await withWriteLock(() => cortexDb.transaction(async (trx) => {
      stored = await applyPreparedFactBatch(prepared, { db: trx });
      for (let index = 0; index < changed.length; index++) {
        const admission = changed[index];
        const result = stored[index];
        await attachFactsToPods([result], attachments, trx);
        const factId = result?.fact?.id ?? result?.existing?.id;
        await supersedeStaleDocFacts(admission.doc.id, factId ? [factId] : [], trx);
      }
      const activeCounts = await countActiveByDocuments(changed.map((admission) => admission.doc.id), trx);
      for (const admission of changed) {
        await documentStore.updateCounts(admission.doc.id, {
          chunkCount: 0,
          factCount: activeCounts.get(Number(admission.doc.id)) || 0,
        }, trx);
      }
      stagedEntityJob = await queueEntityEnrichment({
        documentIds: changed.map((admission) => admission.doc.id),
        namespace: ns,
        title: null,
        sourceType: 'raw',
        metadata: {},
      }, trx);
    }));

    // Preserve a strict one-result-per-input contract. Callers use this array
    // to attribute AUDM verdicts back to the exact input, so changed results
    // cannot simply be followed by unchanged-document sentinels.
    const results = sourceFacts.map(() => ({ action: 'SKIP_EMPTY' }));
    const storedByInput = new Map(changed.map((a, index) => [a.input.originalIndex, stored[index]]));
    for (const admission of admissions) {
      results[admission.input.originalIndex] = admission.changed
        ? { ...storedByInput.get(admission.input.originalIndex), document: admission.doc }
        : { action: 'SKIP_DOCUMENT', document: admission.doc };
    }
    const storedSummary = summarizeFactResults(results);
    // Atomic callers commonly submit several independent facts at once. The
    // single graph job was inserted in the fact transaction above, so the core
    // commit and its enrichment outbox record are all-or-nothing.
    kickIngestionJobRunner();
    const queued = queuedEntityResult(stagedEntityJob);
    const enrichmentJobs = queued.jobUid ? [queued.jobUid] : [];
    return {
      ...storedSummary,
      documents: admissions.map((a) => a.doc),
      unchanged: admissions.length - changed.length,
      enrichmentJobs,
    };
  } catch (err) {
    await Promise.all(changed.map((a) => documentStore.resetHash(a.doc.id).catch(() => {})));
    throw err;
  }
}

// Cheap category hints keep personal facts global on the fast lane. Richer
// classification belongs to asynchronous enrichment, not write acceptance.
function inferAtomicCategory(content) {
  const s = content.toLowerCase();
  if (/\b(prefers?|likes?|dislikes?|hates?|favo(?:u)?rs?)\b/.test(s)) return 'preference';
  if (/\b(decided|decision|chose|picked|moved (?:to|off)|will use)\b/.test(s)) return 'decision';
  if (/\b(must|cannot|can't|required?|constraint|blocked)\b/.test(s)) return 'business_rule';
  if (/\b(bug|issue|failure|broken|risk|limitation)\b/.test(s)) return 'issue';
  if (/\b(todo|follow[- ]?up|needs? to|should)\b/.test(s)) return 'action_item';
  return 'domain_knowledge';
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

function emptyFactCounts(total = 0) {
  return { total, added: 0, skipped: 0, updated: 0, contradicted: 0 };
}

function buildFactSpecs(facts, {
  documentId,
  namespace,
  embeddings,
  defaultConfidence = 'medium',
  defaultImportance = 'supplementary',
} = {}) {
  return facts.map((raw, index) => ({
    content: raw.content,
    category: raw.category,
    confidence: raw.confidence || defaultConfidence,
    importance: raw.importance || defaultImportance,
    namespace,
    sourceDocumentIds: documentId ? [documentId] : [],
    sourceSection: raw.sourceSection || raw.category,
    embedding: embeddings[index],
    visibility: raw.visibility,
  }));
}

function summarizeFactResults(results) {
  const counts = emptyFactCounts(results.length);
  for (const result of results) {
    const action = String(result?.action || '').toLowerCase();
    if (action === 'add') counts.added++;
    else if (action === 'skip' || action === 'skip_document' || action === 'skip_empty') counts.skipped++;
    else if (action === 'update') counts.updated++;
    else if (action === 'contradict') counts.contradicted++;
  }
  return { counts, results };
}

function queuedEntityResult(queued) {
  return queued
    ? { queued: true, jobUid: queued.job.uid, entityCount: 0, relationCount: 0, factEntityLinks: 0, topics: [] }
    : { queued: false, entityCount: 0, relationCount: 0, factEntityLinks: 0, topics: [] };
}


// Resolve the union of pod IDs this document should attach to. Two sources:
//   - explicit `podUids` (hooks pass the active session pod)
//   - connector-derived from `metadata` (workspace pods, etc.)
// Returns [{ podId, role }] suitable for batch-attach.
async function resolvePodAttachments({ podUids, resolvePodsFrom, metadata, namespace }) {
  const attachments = [];

  // Entries are either a bare uid (primary, the long-standing shape) or
  // { uid, role } — hooks use the latter to record a session mention alongside
  // the project that owns the write.
  for (const entry of podUids) {
    const uid = typeof entry === 'string' ? entry : entry?.uid;
    const role = typeof entry === 'string' ? 'primary' : (entry?.role || 'primary');
    if (!uid) {
      // Say so. Skipping in silence is how a caller that handed us
      // `{pod, isNew}` instead of the pod row reported a successful save,
      // attached to nothing, and left an empty pod behind.
      console.error('[pipeline] pod attachment skipped: entry has no uid', JSON.stringify(entry));
      continue;
    }
    const pod = await podStore.findByUid(uid);
    if (pod) attachments.push({ podId: pod.id, role });
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
async function attachFactsToPods(results, attachments, db) {
  if (!attachments.length || !results.length) return;

  for (const r of results) {
    const factId = r?.fact?.id ?? r?.existing?.id;
    if (!factId) continue;

    // Personal facts are about the USER, not about wherever they happened to be
    // sitting. "I prefer tabs over spaces" learned in project A is not a fact
    // about project A, and filing it there hides it everywhere else. Leaving it
    // unattached is what makes it global: scoped search matches "in my pods OR
    // in no pod" (see hybrid-sql.js), so no pod means visible from everywhere.
    // Subject routing still applies afterwards — a preference genuinely ABOUT a
    // project can still reach that project's pod via its entities.
    const category = r?.fact?.category ?? r?.existing?.category ?? null;
    if (category && PERSONAL_CATEGORIES.includes(category)) continue;

    // A re-mention downgrades to 'mention'; so does a pod that only ever
    // wanted the mention. Take the weaker of the two — a pod never gets
    // ownership it did not ask for.
    const byAction = r?.action === 'SKIP' ? 'mention' : 'primary';
    for (const { podId, role } of attachments) {
      const effective = byAction === 'mention' || role === 'mention' ? 'mention' : 'primary';
      await podMembership.attachFact(podId, factId, effective, db);
    }
  }
}


export { ingestDocument, ingestAtomicFacts, inferAtomicCategory };
