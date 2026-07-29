import { beforeEach, describe, expect, it } from 'vitest';

import {
  recallStatus,
  recordPromptRecall,
  resetRecallObservatoryForTests,
} from './recall-observatory.js';

beforeEach(() => resetRecallObservatoryForTests());

describe('runtime automatic-recall observatory', () => {
  it('records only bounded operational evidence, never a prompt or fact payload', () => {
    recordPromptRecall({
      agent: 'codex', namespace: 'default', resultCount: 2, durationMs: 37,
      prompt: 'this must not be retained', facts: ['private fact'],
    });

    const snapshot = recallStatus();
    expect(snapshot.persistence).toBe('runtime-only');
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot.recent[0]).toMatchObject({
      agent: 'codex', namespace: 'default', outcome: 'matched', resultCount: 2, durationMs: 37,
    });
    expect(snapshot.recent[0]).not.toHaveProperty('prompt');
    expect(snapshot.recent[0]).not.toHaveProperty('facts');
  });

  it('groups no-match and matched attempts by agent with the latest first', () => {
    recordPromptRecall({ agent: 'claude-code', resultCount: 0, durationMs: 12 });
    recordPromptRecall({ agent: 'codex', resultCount: 1, durationMs: 8 });
    recordPromptRecall({ agent: 'claude-code', resultCount: 3, durationMs: 14 });

    const snapshot = recallStatus();
    const claude = snapshot.agents.find((entry) => entry.agent === 'claude-code');
    const codex = snapshot.agents.find((entry) => entry.agent === 'codex');
    expect(claude).toMatchObject({ attempts: 2, matched: 1, noMatch: 1, last: { resultCount: 3 } });
    expect(codex).toMatchObject({ attempts: 1, matched: 1, noMatch: 0 });
    expect(snapshot.recent.map((event) => event.agent)).toEqual(['claude-code', 'codex', 'claude-code']);
  });
});
