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

// Fact writes run inside cortexDb.transaction(cb). Deterministic save/supersede
// are mocked, so the trx object is never used — a stub that just invokes the
// callback is enough to avoid a real DB connection.
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
  saveFactDeterministic: vi.fn().mockResolvedValue({ action: 'ADD', fact: { id: 1, uid: 'fact-new' } }),
  supersedeStaleDocFacts: vi.fn().mockResolvedValue({ superseded: 0, dissociated: 0 }),
}));

import { extractFactsFromChunks } from '../memory/facts/extractor.js';
import { saveFactDeterministic, supersedeStaleDocFacts } from '../memory/facts/store.js';
import * as documentStore from '../memory/documents/store.js';
import { getConfig } from '../setup/config-store.js';
import { ingestDocument } from './pipeline.js';

const defaultTestConfig = getConfig();

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockReturnValue(defaultTestConfig);
  // Restore defaults
  documentStore.upsert.mockResolvedValue({ doc: { id: 1, uid: 'doc-test', title: 'Test' }, changed: true });
  documentStore.updateCounts.mockResolvedValue(undefined);
  saveFactDeterministic.mockResolvedValue({ action: 'ADD', fact: { id: 1, uid: 'fact-new' } });
});

describe('ingestDocument — deterministic document route', () => {
  it('runs full pipeline and returns chunk + fact counts', async () => {
    // Full fact extraction remains supported, but is intentionally opt-in for
    // local-first installs because it invokes the configured LLM.
    getConfig.mockReturnValue({
      ...defaultTestConfig,
      ingest: { ...defaultTestConfig.ingest, eagerExtract: true },
    });
    const result = await ingestDocument({
      content: 'A longer piece of content about something important.',
      title: 'Test Document',
      namespace: 'default',
    });

    expect(result.skipped).toBe(false);
    expect(result.route).toBe('document');
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.facts.total).toBeGreaterThan(0);
    expect(saveFactDeterministic).toHaveBeenCalledTimes(2);
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
    expect(saveFactDeterministic).not.toHaveBeenCalled();
  });

  it('defaults to chunks-only and preserves previously extracted facts', async () => {
    await ingestDocument({ content: 'searchable document content', namespace: 'default' });

    expect(extractFactsFromChunks).not.toHaveBeenCalled();
    expect(saveFactDeterministic).not.toHaveBeenCalled();
    expect(supersedeStaleDocFacts).not.toHaveBeenCalled();
    expect(documentStore.updateCounts).toHaveBeenCalledWith(1, { chunkCount: 2 });
  });
});
