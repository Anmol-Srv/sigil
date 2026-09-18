import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/cortex.js', () => ({ default: vi.fn() }));
vi.mock('../facts/entity-linker.js', () => ({ getEntityIdsForFacts: vi.fn() }));

import { applyFactScope, rerank } from './graph-enhancement.js';

function fakeQuery() {
  const query = {
    whereIn: vi.fn(),
    where: vi.fn(),
    whereRaw: vi.fn(),
  };
  query.whereIn.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.whereRaw.mockReturnValue(query);
  return query;
}

describe('graph enhancement scope guard', () => {
  it('reapplies every fact authorization filter before graph facts are selected', () => {
    const query = fakeQuery();
    const viewer = { agent: 'agent-a', deviceId: 9 };
    applyFactScope(query, {
      namespaces: ['project-a'],
      minConfidence: 'high',
      pointInTime: new Date('2026-09-17T00:00:00Z'),
      categories: ['decision'],
      podIds: [7],
      viewer,
    });

    expect(query.whereIn).toHaveBeenCalledWith('fact.namespace', ['project-a']);
    expect(query.whereIn).toHaveBeenCalledWith('fact.category', ['decision']);
    expect(query.where).toHaveBeenCalledWith('fact.status', 'active');
    const raw = query.whereRaw.mock.calls.map(([sql]) => sql).join('\n');
    expect(raw).toContain('fact.valid_from');
    expect(raw).toContain('fact.visibility');
    expect(raw).toContain('pod_membership');
  });

  it('fails closed if a graph caller omits namespaces', () => {
    const query = fakeQuery();
    applyFactScope(query, {});
    expect(query.whereRaw).toHaveBeenCalledWith('FALSE');
  });
});

describe('graph candidate merge', () => {
  it('keeps related facts available to a downstream reranker without exceeding its pool cap', () => {
    const direct = [{ id: 1, rrfScore: 1 }, { id: 2, rrfScore: 0.9 }];
    const related = [{ id: 3, rrfScore: 0.8, relationPath: 'Cache (depends_on)' }];

    expect(rerank(direct, related, [], 3)).toMatchObject([
      { id: 1, resultType: 'direct' },
      { id: 2, resultType: 'direct' },
      { id: 3, resultType: 'related' },
    ]);
  });
});
