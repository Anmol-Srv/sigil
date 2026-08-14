import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---
// The ingest gate (assertEmbeddingReady) consults setup.steps.embedding. On a
// half-configured dev box that step may be 'error'/'pending', which would fail
// these unit tests. Keep the real config shape (config.js reads database/llm/
// embedding through the same getConfig) but force the embedding step to 'done'
// so the gate passes.
vi.mock('../setup/config-store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getConfig: vi.fn(() => ({ ...actual.getConfig(), setup: { steps: { embedding: 'done' } } })),
  };
});

vi.mock('./parsers/index.js', () => ({
  parse: vi.fn().mockReturnValue({
    text: 'parsed document text',
    sections: [{ heading: 'Intro', text: 'Content here' }],
    metadata: { title: 'Test Document' },
  }),
}));

vi.mock('./chunker.js', () => ({
  chunkSections: vi.fn().mockReturnValue([
    { content: 'chunk 1', sectionHeading: 'Intro', contextualPrefix: null },
    { content: 'chunk 2', sectionHeading: 'Intro', contextualPrefix: null },
  ]),
}));

// embedder.js exports embed/embedBatch plus the guarded write-path variants
// embedOrThrow/embedBatchOrThrow (which assert EMBEDDING_DIM=1024). The pipeline
// writes through *OrThrow, so the mock must expose them and emit 1024-d vectors
// — one per input, since assertEmbeddings checks vector count == input count.
vi.mock('./embedder.js', () => {
  const vec = () => Array(1024).fill(0.1);
  const batch = (texts) => texts.map(vec);
  return {
    embed: vi.fn(async () => vec()),
    embedBatch: vi.fn(async (texts) => batch(texts)),
    embedOrThrow: vi.fn(async () => vec()),
    embedBatchOrThrow: vi.fn(async (texts) => batch(texts)),
  };
});

vi.mock('./contextualizer.js', () => ({
  contextualizeChunks: vi.fn((chunks) => Promise.resolve(chunks)),
}));

// Fact writes run inside cortexDb.transaction(cb). saveFact/supersedeStaleDocFacts
// are mocked and these tests attach no pods, so the trx object is never used —
// a stub that just invokes the callback is enough to avoid a real DB connection.
vi.mock('../db/cortex.js', () => ({
  default: Object.assign(vi.fn(), { transaction: vi.fn(async (cb) => cb({})) }),
}));

vi.mock('../memory/documents/store.js', () => ({
  upsert: vi.fn().mockResolvedValue({
    doc: { id: 1, uid: 'doc-test', title: 'Test Document' },
    changed: true,
  }),
  updateCounts: vi.fn().mockResolvedValue(undefined),
  resetHash: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory/chunks/store.js', () => ({
  insertChunks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory/facts/extractor.js', () => ({
  extractFactsFromChunks: vi.fn().mockResolvedValue([
    { content: 'extracted fact 1', category: 'domain_knowledge', confidence: 'high', importance: 'supplementary', sourceSection: 'Intro' },
    { content: 'extracted fact 2', category: 'key_insight', confidence: 'medium', importance: 'supplementary', sourceSection: 'Intro' },
  ]),
}));

vi.mock('../memory/facts/store.js', () => ({
  prepareFactBatch: vi.fn(async (specs) => specs.map((spec) => ({ spec }))),
  applyPreparedFactBatch: vi.fn(async (plans) => plans.map((p, i) => ({ action: 'ADD', fact: { id: i + 1, uid: `fact-new-${i}` } }))),
  countActiveByDocuments: vi.fn(async (ids) => new Map(ids.map((id) => [Number(id), 1]))),
  supersedeStaleDocFacts: vi.fn().mockResolvedValue({ superseded: 0, dissociated: 0 }),
}));

vi.mock('../memory/entities/linker.js', () => ({
  linkDocumentEntities: vi.fn().mockResolvedValue({
    entityCount: 2,
    relationCount: 1,
    factEntityLinks: 2,
    topics: ['test topic'],
  }),
}));

vi.mock('./jobs/runner.js', () => ({
  kickIngestionJobRunner: vi.fn(),
  queueEntityEnrichment: vi.fn(async ({ documentId, documentIds }) => ({
    created: true,
    job: { uid: `job-entity-${documentId || documentIds?.join('-')}` },
  })),
}));

vi.mock('../memory/cognitive/input-classifier.js', () => ({
  classifyInput: vi.fn().mockResolvedValue({
    route: 'knowledge',
    facts: [],
    entities: [],
    reasoning: 'default mock',
  }),
}));

import { classifyInput } from '../memory/cognitive/input-classifier.js';
import { applyPreparedFactBatch } from '../memory/facts/store.js';
import { queueEntityEnrichment } from './jobs/runner.js';
import { embedBatchOrThrow } from './embedder.js';
import { contextualizeChunks } from './contextualizer.js';
import { extractFactsFromChunks } from '../memory/facts/extractor.js';
import * as documentStore from '../memory/documents/store.js';
import { ingestAtomicFacts, ingestDocument } from './pipeline.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Restore defaults
  classifyInput.mockResolvedValue({ route: 'knowledge', facts: [], entities: [], reasoning: '' });
  documentStore.upsert.mockResolvedValue({ doc: { id: 1, uid: 'doc-test', title: 'Test' }, changed: true });
  documentStore.updateCounts.mockResolvedValue(undefined);
  applyPreparedFactBatch.mockImplementation(async (plans) => plans.map((p, i) => ({ action: 'ADD', fact: { id: i + 1, uid: `fact-new-${i}` } })));
});

describe('ingestDocument — noise route', () => {
  it('returns skipped=true and no documentId when classified as noise', async () => {
    classifyInput.mockResolvedValue({ route: 'noise', facts: [], entities: [], reasoning: 'too short' });

    const result = await ingestDocument({
      content: 'hi',
      title: 'test',
      namespace: 'default',
    });

    expect(result.skipped).toBe(true);
    expect(result.documentId).toBeNull();
    expect(result.route).toBe('noise');
  });
});

describe('ingestDocument — thought route', () => {
  it('stores facts directly and skips chunking', async () => {
    classifyInput.mockResolvedValue({
      route: 'thought',
      facts: [
        { content: 'I prefer mango over apple', category: 'preference', confidence: 'high', importance: 'vital' },
        { content: 'I dislike durian', category: 'preference', confidence: 'high', importance: 'vital' },
      ],
      entities: ['mango', 'apple', 'durian'],
      reasoning: 'personal preference',
    });

    const result = await ingestDocument({
      content: 'I prefer mango over apple. I dislike durian.',
      namespace: 'default',
    });

    expect(result.skipped).toBe(false);
    expect(result.route).toBe('thought');
    expect(result.chunkCount).toBe(0);
    expect(applyPreparedFactBatch).toHaveBeenCalledTimes(1);
  });

  it('thought route counts added facts correctly', async () => {
    applyPreparedFactBatch.mockResolvedValueOnce([
      { action: 'ADD', fact: { id: 1 } },
      { action: 'SKIP', existing: { id: 2 } },
    ]);

    classifyInput.mockResolvedValue({
      route: 'thought',
      facts: [
        { content: 'fact one', category: 'preference', confidence: 'high', importance: 'vital' },
        { content: 'fact two', category: 'preference', confidence: 'high', importance: 'vital' },
      ],
      entities: [],
      reasoning: '',
    });

    const result = await ingestDocument({ content: 'two facts', namespace: 'default' });
    expect(result.facts.added).toBe(1);
    expect(result.facts.skipped).toBe(1);
  });

  it('resets an admitted hash when thought preparation fails', async () => {
    classifyInput.mockResolvedValue({
      route: 'thought',
      facts: [{ content: 'new version fact', category: 'decision', confidence: 'high' }],
      entities: [],
      reasoning: '',
    });
    embedBatchOrThrow.mockRejectedValueOnce(new Error('embedding unavailable'));

    await expect(ingestDocument({ content: 'changed source', namespace: 'default' }))
      .rejects.toThrow('embedding unavailable');
    expect(documentStore.resetHash).toHaveBeenCalledWith(1);
  });
});

describe('ingestDocument — document/knowledge route', () => {
  it('runs full pipeline and returns chunk + fact counts', async () => {
    classifyInput.mockResolvedValue({ route: 'knowledge', facts: [], entities: [], reasoning: '' });

    const result = await ingestDocument({
      content: 'A longer piece of content about something important.',
      title: 'Test Document',
      namespace: 'default',
    });

    expect(result.skipped).toBe(false);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.facts.total).toBeGreaterThan(0);
  });

  it('skips processing when content hash is unchanged', async () => {
    documentStore.upsert.mockResolvedValue({
      doc: { id: 1, uid: 'doc-test', title: 'Test' },
      changed: false,
    });

    const result = await ingestDocument({
      content: 'unchanged content',
      namespace: 'default',
    });

    expect(result.skipped).toBe(true);
    expect(applyPreparedFactBatch).not.toHaveBeenCalled();
  });

  it('force reprocesses an admitted hash for durable crash recovery', async () => {
    documentStore.upsert.mockResolvedValue({
      doc: { id: 1, uid: 'doc-test', title: 'Test' },
      changed: false,
    });

    const result = await ingestDocument({
      content: 'content admitted by an interrupted prior attempt',
      namespace: 'default',
      force: true,
    });

    expect(result.skipped).toBe(false);
    expect(applyPreparedFactBatch).toHaveBeenCalled();
  });

  it('classify=false skips the classifier entirely', async () => {
    const result = await ingestDocument({
      content: 'content without classification',
      namespace: 'default',
      classify: false,
    });

    expect(classifyInput).not.toHaveBeenCalled();
    expect(result.skipped).toBe(false);
  });

  it('classify=false + atomic stores verbatim without the document LLM path', async () => {
    const result = await ingestDocument({
      content: 'Project uses Postgres LISTEN/NOTIFY',
      namespace: 'default',
      classify: false,
      atomic: true,
    });

    expect(result.route).toBe('thought');
    expect(result.chunkCount).toBe(0);
    expect(classifyInput).not.toHaveBeenCalled();
    expect(contextualizeChunks).not.toHaveBeenCalled();
    expect(extractFactsFromChunks).not.toHaveBeenCalled();
  });
});

describe('ingestAtomicFacts', () => {
  it('recovers a fact whose document was admitted before an interrupted commit', async () => {
    documentStore.upsert.mockResolvedValueOnce({
      doc: { id: 31, uid: 'doc-incomplete', factCount: 0, chunkCount: 0 },
      changed: false,
    });
    applyPreparedFactBatch.mockResolvedValueOnce([
      { action: 'ADD', fact: { id: 41, uid: 'fact-recovered' } },
    ]);

    const result = await ingestAtomicFacts({ facts: ['recover this fact'], namespace: 'default' });
    expect(result.results[0]).toMatchObject({ action: 'ADD', fact: { uid: 'fact-recovered' } });
  });

  it('keeps verdicts aligned with changed, unchanged, and empty inputs', async () => {
    documentStore.upsert
      .mockResolvedValueOnce({ doc: { id: 11, uid: 'doc-changed' }, changed: true })
      .mockResolvedValueOnce({ doc: { id: 12, uid: 'doc-known' }, changed: false });
    applyPreparedFactBatch.mockResolvedValueOnce([
      { action: 'ADD', fact: { id: 21, uid: 'fact-added' } },
    ]);

    const result = await ingestAtomicFacts({
      facts: ['new fact', 'already known', '   '],
      namespace: 'default',
    });

    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.action)).toEqual(['ADD', 'SKIP_DOCUMENT', 'SKIP_EMPTY']);
    expect(result.results[0].fact.uid).toBe('fact-added');
    expect(result.results[1].document.uid).toBe('doc-known');
    expect(result.counts).toMatchObject({ total: 3, added: 1, skipped: 2 });
    expect(queueEntityEnrichment).toHaveBeenCalledTimes(1);
    expect(queueEntityEnrichment).toHaveBeenCalledWith(expect.objectContaining({ documentIds: [11] }), expect.anything());
  });

  it('batches graph enrichment for multiple accepted facts', async () => {
    documentStore.upsert
      .mockResolvedValueOnce({ doc: { id: 51, uid: 'doc-one' }, changed: true })
      .mockResolvedValueOnce({ doc: { id: 52, uid: 'doc-two' }, changed: true });

    await ingestAtomicFacts({ facts: ['first fact', 'second fact'], namespace: 'default' });

    expect(queueEntityEnrichment).toHaveBeenCalledTimes(1);
    expect(queueEntityEnrichment).toHaveBeenCalledWith(expect.objectContaining({ documentIds: [51, 52] }), expect.anything());
  });
});
