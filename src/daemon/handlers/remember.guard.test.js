// `remember` takes ONE short self-contained statement. Agents reached for it
// for everything — it was the only save tool the instructions mentioned — so
// whole markdown files and session histories were landing in the fact store,
// shredded into fact rows with no way to recover the original. The guard makes
// that a loud, actionable refusal instead of silent damage.

import { describe, it, expect, beforeAll, vi } from 'vitest';

import { createRegistry } from '../rpc-registry.js';

let registry;

beforeAll(async () => {
  // The handler pulls in the ingest pipeline lazily; the guard rejects before
  // any of that runs, so a stub is enough to keep the import graph off the DB.
  vi.doMock('../../ingestion/pipeline.js', () => ({
    ingestAtomicFacts: vi.fn(async ({ facts }) => ({
      counts: { total: facts.length, added: 0, updated: 0, contradicted: 0, skipped: facts.length },
      results: facts.map(() => ({ action: 'SKIP_DOCUMENT' })),
    })),
  }));
  vi.doMock('../../config.js', () => ({ default: { defaults: { namespace: 'default' } } }));

  const { registerRemember } = await import('./remember.js');
  registry = createRegistry();
  registerRemember(registry);
});

const remember = (...facts) => registry.dispatch('remember', { facts });

describe('remember document guard', () => {
  it('accepts a normal fact', async () => {
    // Reaches the pipeline (stubbed) rather than being refused — that is the
    // signal we care about; the guard let it through.
    const res = await remember('User prefers tabs over spaces');
    expect(res.error?.code).not.toBe('invalid_params');
  });

  it('accepts a long-but-genuine single-sentence fact', async () => {
    const res = await remember(
      'The team decided to move off Redis to Postgres LISTEN/NOTIFY because the '
      + 'operational cost of a second datastore was not justified by the throughput '
      + 'they actually needed, and the migration landed in Q3.',
    );
    expect(res.error?.code).not.toBe('invalid_params');
  });

  it('rejects a markdown document', async () => {
    const res = await remember('# Design Notes\n\n## Goals\n\n- one\n- two\n\n## Non-goals\n\nnope.');
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_params');
    expect(res.error.message).toContain('document');
    // The message must name the tool that does the right job.
    expect(res.error.message).toContain('ingest');
  });

  it('rejects an oversized blob', async () => {
    const res = await remember('a very long sentence about the system. '.repeat(100));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_params');
  });

  it('rejects a many-line paste (a session history)', async () => {
    const res = await remember(Array.from({ length: 40 }, (_, i) => `line ${i} of a transcript`).join('\n'));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_params');
  });

  it('rejects the batch if ANY entry is a document', async () => {
    const res = await remember('User prefers tabs', '# A Doc\n\n## H\n\ncontent here\nmore\nlines\n');
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_params');
  });
});
