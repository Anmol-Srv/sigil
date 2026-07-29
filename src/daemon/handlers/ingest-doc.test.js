import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
  resolveSource: vi.fn(),
  recordTrace: vi.fn(),
}));

vi.mock('../../ingestion/pipeline.js', () => ({ ingestDocument: mocks.ingestDocument }));
vi.mock('../../ingestion/resolve-source.js', () => ({ resolveSource: mocks.resolveSource }));
vi.mock('../trace-store.js', () => ({ recordTrace: mocks.recordTrace }));

import { createRegistry } from '../rpc-registry.js';
import { registerIngestDoc } from './ingest-doc.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSource.mockResolvedValue({
    content: 'A durable source document', title: 'Source', sourcePath: null,
    sourceType: 'text', contentType: 'text/plain', metadata: {},
  });
  mocks.ingestDocument.mockResolvedValue({
    title: 'Source', documentId: 11, chunkCount: 2,
    facts: { total: 0, added: 0, skipped: 0, verdicts: [] },
  });
  mocks.recordTrace.mockResolvedValue(undefined);
});

describe('ingestDoc RPC', () => {
  it('uses the caller project for an implicit document namespace', async () => {
    const registry = createRegistry();
    registerIngestDoc(registry);
    const projectNamespace = 'project:1234567890abcdef12345678';

    const response = await registry.dispatch(
      'ingestDoc',
      { content: 'A durable source document' },
      { transport: 'socket', agent: 'codex', scope: { projectNamespace } },
    );

    expect(response.ok).toBe(true);
    expect(mocks.ingestDocument).toHaveBeenCalledWith(expect.objectContaining({
      namespace: projectNamespace,
    }));
    expect(mocks.recordTrace).toHaveBeenCalledWith(expect.objectContaining({
      namespace: projectNamespace,
    }));
  });
});
