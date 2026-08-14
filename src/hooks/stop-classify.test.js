import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptJson = vi.fn();
vi.mock('../lib/llm.js', () => ({ promptJson }));
vi.mock('../config.js', () => ({ default: { llm: { extractionModel: '' } } }));

import { classifyTurns } from './stop-classify.js';

beforeEach(() => vi.clearAllMocks());

describe('Stop spool batch classification', () => {
  it('classifies independent replay turns in one provider call', async () => {
    promptJson.mockResolvedValue({
      turns: [
        { index: 0, memorable: true, facts: ['Project uses Postgres.'] },
        { index: 1, memorable: false, facts: [] },
      ],
    });

    const result = await classifyTurns(['we use postgres', 'thanks']);
    expect(promptJson).toHaveBeenCalledTimes(1);
    expect(promptJson.mock.calls[0][1].caller).toBe('stop-spool');
    expect(result).toEqual([['Project uses Postgres.'], []]);
  });
});
