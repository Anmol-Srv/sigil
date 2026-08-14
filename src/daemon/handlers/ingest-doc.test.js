import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createRegistry } from '../rpc-registry.js';

const enqueueAndKick = vi.fn(async () => ({
  created: true,
  job: { uid: 'job-durable-1' },
}));

let registry;

beforeAll(async () => {
  vi.doMock('../../ingestion/jobs/runner.js', () => ({ enqueueAndKick }));
  const { registerIngestDoc } = await import('./ingest-doc.js');
  registry = createRegistry();
  registerIngestDoc(registry);
});

describe('ingestDoc durable background admission', () => {
  it('stages resolved source bytes before returning the job acknowledgement', async () => {
    const response = await registry.dispatch('ingestDoc', {
      content: 'A document that must survive daemon restart.',
      title: 'Durable doc',
      sourcePath: '/project/durable.md',
      namespace: 'default',
      background: true,
    });

    expect(response).toMatchObject({
      ok: true,
      data: { queued: true, durable: true, jobUid: 'job-durable-1', title: 'Durable doc' },
    });
    expect(enqueueAndKick).toHaveBeenCalledTimes(1);
    expect(enqueueAndKick.mock.calls[0][0]).toMatchObject({
      kind: 'document-ingest',
      namespace: 'default',
      dedupeKey: expect.stringMatching(/^document-ingest:[a-f0-9]{64}$/),
      rerunIfRunning: false,
      payload: {
        content: 'A document that must survive daemon restart.',
        sourcePath: '/project/durable.md',
        filePath: null,
        url: null,
        background: false,
      },
    });
  });
});
