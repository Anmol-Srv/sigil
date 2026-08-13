// `vital` gates the always-on hot-context slots and multiplies the search
// score. Both only work if the flag is scarce. Three code paths used to default
// it UP when the classifier returned nothing usable, which on a real store left
// 50 of 62 facts vital — at which point neither consumer can discriminate and
// the always-on slots fill with whatever was ingested most recently.
//
// These pin the direction of every default: judgement can promote, absence
// never does.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/llm.js', () => ({
  promptJson: vi.fn(),
  prompt: vi.fn(),
  parseJson: vi.fn(),
}));

import { promptJson } from '../../lib/llm.js';
import { classifyInput } from './input-classifier.js';

beforeEach(() => {
  vi.clearAllMocks();
});

const thought = (facts) => ({ route: 'thought', facts, entities: [], reasoning: '' });

describe('importance defaults down, never up', () => {
  it('treats a missing importance as supplementary', async () => {
    promptJson.mockResolvedValue(thought([
      { content: 'The chunker splits on headings', category: 'architecture', confidence: 'high' },
    ]));

    const { facts } = await classifyInput('the chunker splits on headings');
    expect(facts[0].importance).toBe('supplementary');
  });

  it('treats an unrecognised importance as supplementary', async () => {
    promptJson.mockResolvedValue(thought([
      { content: 'Retries cap at three', category: 'convention', confidence: 'high', importance: 'CRITICAL!!' },
    ]));

    const { facts } = await classifyInput('retries cap at three');
    expect(facts[0].importance).toBe('supplementary');
  });

  it('still honours an explicit vital', async () => {
    // The fix must not make vital unreachable — a judged fact keeps its rating.
    promptJson.mockResolvedValue(thought([
      { content: 'User wants short answers', category: 'preference', confidence: 'high', importance: 'vital' },
    ]));

    const { facts } = await classifyInput('I want short answers');
    expect(facts[0].importance).toBe('vital');
  });

  it('does not mark a fact vital when classification failed outright', async () => {
    // The atomic fallback runs precisely when nothing judged the content, which
    // is the weakest possible claim to a permanent slot in every future prompt.
    promptJson.mockRejectedValue(new Error('LLM unreachable'));

    const { route, facts } = await classifyInput('some atomic fact', { atomic: true });
    expect(route).toBe('thought');
    expect(facts[0].importance).toBe('supplementary');
  });

  it('does not mark a fact vital when the classifier returns garbage', async () => {
    promptJson.mockResolvedValue({ route: 'not-a-route' });

    const { facts } = await classifyInput('some atomic fact', { atomic: true });
    expect(facts[0].importance).toBe('supplementary');
  });
});
