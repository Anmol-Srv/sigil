// Symmetric secret masking on the WRITE path (Lane G).
//
// Read-side masking (hooks → injection) already existed; the gap was the
// capture/embed path, where ingested secrets reached the embedding API and
// got stored in plaintext. saveFact now masks content BEFORE embedding, so:
//   1. the text handed to the embedder is masked (no exfiltration), and
//   2. the stored fact content is masked.
//
// cortex.js is stubbed (not PGlite) so this test doesn't depend on the
// halfvec vector path — it isolates the masking choke point.

import { describe, it, expect, vi, beforeAll } from 'vitest';

const SECRET = 'my key is sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH and db is postgres://admin:s3cretpw@dbhost/app';

const embedCalls = [];
const insertedRows = [];

beforeAll(() => {
  // Capture what the embedder receives.
  vi.doMock('../../ingestion/embedder.js', () => ({
    embed: vi.fn(async (text) => { embedCalls.push(text); return Array(768).fill(0.01); }),
    embedBatch: vi.fn(async (texts) => texts.map(() => Array(768).fill(0.01))),
  }));
  vi.doMock('../../lib/llm.js', () => ({ prompt: vi.fn(), promptJson: vi.fn() }));

  // Minimal knex-shaped stub: no similar facts, capture the inserted row.
  const fakeDb = (table) => ({
    insert: (row) => ({ returning: async () => { insertedRows.push(row); return [{ id: 1, ...row }]; } }),
    where: () => ({ update: async () => 1 }),
  });
  fakeDb.transaction = async (cb) => cb({ raw: async () => ({ rows: [] }) });
  fakeDb.raw = async () => ({ rows: [] });
  fakeDb.fn = { now: () => new Date() };
  vi.doMock('../../db/cortex.js', () => ({ default: fakeDb }));
});

describe('saveFact secret masking (write path)', () => {
  it('masks secrets before embedding AND before storing', async () => {
    const { saveFact } = await import('./store.js');

    await saveFact({
      content: SECRET,
      category: 'domain_knowledge',
      confidence: 'high',
      importance: 'supplementary',
      namespace: 'default',
      sourceDocumentIds: [],
      sourceSection: null,
      // no precomputed embedding → saveFact calls embed(content)
    });

    // The embedder must have been called with masked text (no raw secret).
    expect(embedCalls.length).toBeGreaterThan(0);
    const embedded = embedCalls[0];
    expect(embedded).not.toContain('sk-ant-api03-AAAA'); // Layer 1: API key
    expect(embedded).not.toContain('admin:s3cretpw');    // Layer 3: URL creds
    expect(embedded).toContain('MASKED');

    // The stored content must also be masked.
    expect(insertedRows.length).toBeGreaterThan(0);
    expect(insertedRows[0].content).not.toContain('sk-ant-api03-AAAA');
    expect(insertedRows[0].content).not.toContain('admin:s3cretpw');
    expect(insertedRows[0].content).toContain('MASKED');
  });
});
