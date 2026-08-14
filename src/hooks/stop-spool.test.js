import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const classifyTurns = vi.fn();
const saveFacts = vi.fn();
const testDir = mkdtempSync(join(tmpdir(), 'sigil-spool-test-'));
const spoolPath = join(testDir, 'stop.jsonl');

beforeAll(() => {
  vi.doMock('../lib/paths.js', () => ({ SIGIL_STOP_SPOOL: spoolPath }));
  vi.doMock('./stop-classify.js', () => ({ classifyTurns, saveFacts }));
});

afterAll(() => rmSync(testDir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(spoolPath, { force: true });
  rmSync(`${spoolPath}.acked`, { force: true });
  vi.clearAllMocks();
});

describe('Stop spool acknowledgements', () => {
  it('batches replay and never rewrites away later unacknowledged turns', async () => {
    const spool = await import('./stop-spool.js');
    spool.appendSpool({ message: 'Project uses Postgres.', reason: 'timeout' });
    spool.appendSpool({ message: 'User prefers concise responses.', reason: 'timeout' });
    classifyTurns.mockResolvedValue([
      ['Project uses Postgres.'],
      ['User prefers concise responses.'],
    ]);

    const result = await spool.drainStopSpool();
    expect(result).toMatchObject({ drained: 2, remaining: 0, replayed: 2 });
    expect(classifyTurns).toHaveBeenCalledTimes(1);
    expect(saveFacts).toHaveBeenCalledTimes(1);

    spool.appendSpool({ message: 'A later unacknowledged turn.', reason: 'new' });
    expect(spool.spoolCount()).toBe(1);
  });

  it('leaves a whole batch pending when its save fails', async () => {
    const spool = await import('./stop-spool.js');
    spool.appendSpool({ message: 'Project uses SQLite.', reason: 'timeout' });
    classifyTurns.mockResolvedValue([['Project uses SQLite.']]);
    saveFacts.mockRejectedValue(new Error('db down'));

    await expect(spool.drainStopSpool()).resolves.toMatchObject({ drained: 0, remaining: 1 });
    expect(spool.spoolCount()).toBe(1);
  });
});
