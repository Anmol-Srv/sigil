import { beforeEach, describe, expect, it } from 'vitest';

import { createRegistry } from '../rpc-registry.js';
import { recordPromptRecall, resetRecallObservatoryForTests } from '../recall-observatory.js';
import { registerRecall } from './recall.js';

beforeEach(() => resetRecallObservatoryForTests());

describe('recall.status RPC', () => {
  it('returns runtime-only prompt-recall evidence without a trace database dependency', async () => {
    recordPromptRecall({ agent: 'codex', resultCount: 2, durationMs: 21 });
    const registry = createRegistry();
    registerRecall(registry);

    const response = await registry.dispatch('recall.status', {});

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      persistence: 'runtime-only',
      agents: [expect.objectContaining({ agent: 'codex', attempts: 1, matched: 1 })],
    });
  });
});
