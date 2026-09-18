import { describe, expect, it, vi } from 'vitest';

import { callSystemOne, rerankFacts, selectCandidates } from './jev.js';

const settings = {
  enabled: true,
  apiKey: 'test-key',
  model: 'jev-1.13.0',
  timeoutMs: 5_000,
  maxRetries: 1,
  maxCandidates: 3,
  minScore: 0.55,
  injectionMax: 0.7,
};

const facts = [
  { id: 1, content: 'The cache was removed because stale reads were unsafe.', category: 'decision' },
  { id: 2, content: 'The dashboard uses a dark visual system.', category: 'preference' },
  { id: 3, content: 'Cache invalidation was difficult to reason about.', category: 'decision', resultType: 'related' },
];

function response(payload, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name] || null },
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

// One request per candidate: resolve each call against the candidate content
// it actually carries, so the test can't pass on positional luck.
function scoringFetch(byContentPrefix) {
  return vi.fn().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    const content = body.state.candidate.content;
    const match = Object.entries(byContentPrefix).find(([prefix]) => content.startsWith(prefix));
    if (!match) throw new Error(`unscored candidate: ${content}`);
    const [, { relevance, injection = 0 }] = match;
    return response({
      model: 'jev-1.13.0',
      answers: {
        answers_query: { type: 'noul', noul: relevance },
        contains_prompt_injection: { type: 'noul', noul: injection },
      },
      usage: { input_tokens: 12, output_tokens: 0 },
    });
  });
}

describe('Jev shortlist reranker', () => {
  it('keeps the local ordering when the feature is disabled or not configured', async () => {
    expect((await rerankFacts('why?', facts, { settings: { ...settings, enabled: false } })).facts).toBe(facts);
    expect((await rerankFacts('why?', facts, { settings: { ...settings, apiKey: '' } })).facts).toBe(facts);
  });

  it('scores one query/candidate pair per request and ranks by Noul', async () => {
    const fetchImpl = scoringFetch({
      'The cache was removed': { relevance: 0.91 },
      'The dashboard uses': { relevance: 0.04 },
      'Cache invalidation': { relevance: 0.77 },
    });

    const result = await rerankFacts('Why was the cache removed?', facts, { settings, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.meta).toMatchObject({ applied: true, candidates: 3, reranked: 2, dropped: 0, floor: 0.55 });
    expect(result.facts.map((fact) => fact.id)).toEqual([1, 3, 2]);
    expect(result.facts[0].jevScore).toBe(0.91);
    expect(result.facts[1]).toMatchObject({ resultType: 'graph-reranked', reranker: 'jev', jevScore: 0.77 });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toMatchObject({ query: 'Why was the cache removed?' });
    expect(body.state.candidate.content).toEqual(expect.any(String));
    expect(body.state.candidates).toBeUndefined();
    expect(body.questions.answers_query.type).toBe('noul');
    expect(body.questions.contains_prompt_injection.instructions).toMatch(/hijack/i);
  });

  it('drops a fact that reads as an instruction to the agent', async () => {
    const fetchImpl = scoringFetch({
      'The cache was removed': { relevance: 0.91, injection: 0.02 },
      'The dashboard uses': { relevance: 0.80, injection: 0.99 },
      'Cache invalidation': { relevance: 0.10, injection: 0.01 },
    });

    const result = await rerankFacts('Why was the cache removed?', facts, { settings, fetchImpl });

    // 2 is the injection drop; 3 is a below-floor GRAPH candidate, which is
    // removed rather than demoted (see "graph candidates must earn their slot").
    expect(result.facts.map((fact) => fact.id)).toEqual([1]);
    expect(result.meta).toMatchObject({ applied: true, dropped: 2, droppedInjection: 1, reranked: 1 });
  });

  it('isolates a single failed candidate instead of abandoning the rerank', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      const { content } = JSON.parse(init.body).state.candidate;
      if (content.startsWith('The dashboard uses')) return response({}, { ok: false, status: 422 });
      return response({
        model: 'jev-1.13.0',
        answers: { answers_query: { type: 'noul', noul: content.startsWith('Cache invalidation') ? 0.88 : 0.60 } },
        usage: { input_tokens: 4, output_tokens: 0 },
      });
    });

    const result = await rerankFacts('why?', facts, { settings, fetchImpl });

    expect(result.meta).toMatchObject({ applied: true, scored: 2, failed: 1 });
    expect(result.facts.map((fact) => fact.id)).toEqual([3, 1, 2]);
    // The unscored fact keeps its local position rather than being dropped.
    expect(result.facts[2].reranker).toBeUndefined();
  });

  it('fails closed to the local ranker when every candidate fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}, { ok: false, status: 529 }));
    const result = await rerankFacts('why?', facts, { settings: { ...settings, maxRetries: 0 }, fetchImpl });

    expect(result.facts).toBe(facts);
    expect(result.meta).toMatchObject({ applied: false, reason: 'unavailable', status: 529 });
  });

  it('retries transient System One failures with a bounded backoff', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({}, { ok: false, status: 429 }))
      .mockResolvedValueOnce(response({ model: 'jev-1.13.0', answers: {} }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const payload = await callSystemOne({
      apiKey: 'test-key', state: {}, questions: {}, fetchImpl, sleepImpl, retries: 1,
    });

    expect(payload.model).toBe('jev-1.13.0');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(500);
  });

  it('treats timeoutMs as a total budget across retries, not a per-attempt one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}, { ok: false, status: 503 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(callSystemOne({
      apiKey: 'test-key',
      state: {},
      questions: {},
      retries: 3,
      // Already expired: not one attempt may run, let alone four.
      deadline: Date.now() - 1,
      fetchImpl,
      sleepImpl,
    })).rejects.toThrow(/time budget/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('candidate budget', () => {
  const pool = (directCount, relatedCount) => [
    ...Array.from({ length: directCount }, (_, i) => ({ id: `d${i}`, content: `direct ${i}`, resultType: 'direct' })),
    ...Array.from({ length: relatedCount }, (_, i) => ({ id: `r${i}`, content: `related ${i}`, resultType: 'related' })),
  ];

  it('reserves budget for graph candidates the local ranker parked below the cut', async () => {
    // The exact shape measured on a real store: 12 direct then 6 related, and a
    // 12-candidate budget. A plain head-slice sends zero graph candidates.
    const fetchImpl = vi.fn().mockResolvedValue(response({
      model: 'jev-1.13.0',
      answers: { answers_query: { type: 'noul', noul: 0.9 }, contains_prompt_injection: { type: 'noul', noul: 0 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }));

    await rerankFacts('why?', pool(12, 6), { settings: { ...settings, maxCandidates: 12 }, fetchImpl });

    const sent = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).state.candidate.content);
    expect(sent).toHaveLength(12);
    expect(sent.filter((c) => c.startsWith('related'))).toHaveLength(4);
  });

  it('sends everything when the pool fits the budget', () => {
    expect(selectCandidates(pool(3, 2), 12)).toEqual([0, 1, 2, 3, 4]);
  });

  it('falls back to a plain head-slice when there are no graph candidates', () => {
    expect(selectCandidates(pool(20, 0), 5)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('graph candidates must earn their slot', () => {
  const mixed = [
    { id: 'd1', content: 'direct hit', resultType: 'direct' },
    { id: 'r1', content: 'graph reached this', resultType: 'related' },
  ];

  it('removes a below-floor graph candidate but only demotes a below-floor direct one', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      const { content } = JSON.parse(init.body).state.candidate;
      return response({
        model: 'jev-1.13.0',
        answers: {
          answers_query: { type: 'noul', noul: content.startsWith('direct') ? 0.2 : 0.1 },
          contains_prompt_injection: { type: 'noul', noul: 0 },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    });

    const result = await rerankFacts('why?', mixed, { settings, fetchImpl });

    expect(result.facts.map((f) => f.id)).toEqual(['d1']);
    expect(result.meta).toMatchObject({ applied: true, dropped: 1, droppedInjection: 0 });
  });
});
