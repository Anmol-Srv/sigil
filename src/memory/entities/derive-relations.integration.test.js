import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';

let pg;
let db;
let deriveCandidates;
let recordRejectedCandidates;

const snake = (value) => value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (row) => {
  if (!row || typeof row !== 'object' || row instanceof Date) return row;
  if (Array.isArray(row)) return row.map(camel);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE TABLE fact (
      id BIGSERIAL PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL,
      namespace TEXT NOT NULL
    );
    CREATE TABLE entity (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, entity_type TEXT NOT NULL,
      merged_with BIGINT
    );
    CREATE TABLE fact_entity (
      fact_id BIGINT NOT NULL REFERENCES fact(id),
      entity_id BIGINT NOT NULL REFERENCES entity(id)
    );
    CREATE TABLE relation (
      id BIGSERIAL PRIMARY KEY, source_id BIGINT NOT NULL, target_id BIGINT NOT NULL
    );
    CREATE TABLE relation_candidate_judgment (
      id BIGSERIAL PRIMARY KEY,
      source_id BIGINT NOT NULL REFERENCES entity(id),
      target_id BIGINT NOT NULL REFERENCES entity(id),
      shared_facts INTEGER NOT NULL,
      decision TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_id, target_id)
    );
    INSERT INTO entity (id, name, entity_type) VALUES (1, 'Sigil', 'project'), (2, 'PGlite', 'technology');
    INSERT INTO fact (id, content, status, namespace) VALUES (1, 'Sigil uses PGlite', 'active', 'test');
    INSERT INTO fact_entity (fact_id, entity_id) VALUES (1, 1), (1, 2);
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    wrapIdentifier: (value, orig) => orig(snake(value)),
    postProcessResponse: (result) => camel(result),
  });
  db.client._injectedPglite = pg;
  vi.doMock('../../db/cortex.js', () => ({ default: db }));
  ({ deriveCandidates, recordRejectedCandidates } = await import('./derive-relations.js'));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

describe('relation candidate judgment convergence', () => {
  it('skips unchanged rejected evidence and reopens the pair when evidence grows', async () => {
    const first = await deriveCandidates({ namespace: 'test' });
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({ sourceId: 1, targetId: 2, sharedFacts: 1 });

    await recordRejectedCandidates(first.candidates, db);
    expect((await deriveCandidates({ namespace: 'test' })).candidates).toHaveLength(0);

    await pg.exec(`
      INSERT INTO fact (id, content, status, namespace) VALUES (2, 'PGlite powers Sigil locally', 'active', 'test');
      INSERT INTO fact_entity (fact_id, entity_id) VALUES (2, 1), (2, 2);
    `);
    const reconsidered = await deriveCandidates({ namespace: 'test' });
    expect(reconsidered.candidates).toHaveLength(1);
    expect(reconsidered.candidates[0].sharedFacts).toBe(2);
  });
});
