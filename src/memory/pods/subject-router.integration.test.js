// Subject routing: a fact goes in the pod it is ABOUT, not only the one it was
// written in. The failure this fixes — standing in the `sigil` repo and saying
// "remember that srver's F0 uses Cloud Hypervisor" files the fact under sigil,
// so returning to srver never recalls it.
//
// The attachment itself lives in facts/entity-linker.js (attachFactToEntityPods)
// and always has — it was the wire behind hot-context's person slots. What was
// missing is the BINDING: project pods carried no entity_id, so that query could
// never see them. These cover both halves, plus the backfill that replays the
// same attachment over facts written before any of it existed.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';

let pg;
let db;
let router;
let linker;

const toCamel = (o) => {
  if (!o || typeof o !== 'object' || o instanceof Date) return o;
  if (Array.isArray(o)) return o.map(toCamel);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
};
const wrapIdentifier = (v, orig) => orig(v.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE TABLE fact (id BIGSERIAL PRIMARY KEY, content TEXT, status TEXT DEFAULT 'active');
    -- Mirrors the REAL entity table (create + later ALTERs). Getting this wrong
    -- hides broken queries: an earlier draft omitted merged_with/aliases and the
    -- production findByName() failed while the fixture happily passed.
    CREATE TABLE entity (
      id SERIAL PRIMARY KEY, uid TEXT, name TEXT, entity_type TEXT,
      entity_types TEXT, description TEXT, external_id TEXT,
      namespace TEXT DEFAULT 'default', merged_with INTEGER,
      aliases TEXT[] DEFAULT '{}', mention_count INTEGER DEFAULT 1, embedding TEXT,
      first_seen_at TIMESTAMP DEFAULT NOW(), last_seen_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE fact_entity (
      id SERIAL PRIMARY KEY, fact_id BIGINT, entity_id INTEGER,
      mention_type TEXT DEFAULT 'content', mention_count INTEGER DEFAULT 1
    );
    CREATE TABLE pod (
      id SERIAL PRIMARY KEY, uid TEXT, pod_type TEXT, name TEXT,
      namespace TEXT DEFAULT 'default', status TEXT DEFAULT 'active',
      entity_id INTEGER, member_doc_count INT DEFAULT 0, member_fact_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE pod_membership (
      id SERIAL PRIMARY KEY, pod_id INTEGER NOT NULL, member_type TEXT NOT NULL,
      member_id BIGINT NOT NULL, role TEXT,
      UNIQUE (pod_id, member_type, member_id)
    );

    INSERT INTO entity (id, name, entity_type) VALUES
      (1,'srver','topic'), (2,'sigil','topic'), (3,'unbound-topic','topic');
    -- pod 1 = srver (entity-bound), pod 2 = sigil (entity-bound),
    -- pod 3 = a pod with NO entity binding (must never collect subject matches)
    INSERT INTO pod (id, uid, pod_type, name, entity_id) VALUES
      (1,'pod-srver','project','srver',1),
      (2,'pod-sigil','project','sigil',2),
      (3,'pod-loose','project','loose',NULL);

    -- fact 1: written in sigil, ABOUT srver
    INSERT INTO fact (id, content) VALUES (1,'srver F0 uses Cloud Hypervisor');
    INSERT INTO fact_entity (fact_id, entity_id, mention_count) VALUES (1,1,3);
    -- fact 2: mentions an entity no pod is bound to
    INSERT INTO fact (id, content) VALUES (2,'something about an unbound topic');
    INSERT INTO fact_entity (fact_id, entity_id) VALUES (2,3);
    -- fact 3: about two bound projects, to prove ranking + cap
    INSERT INTO fact (id, content) VALUES (3,'touches everything');
    INSERT INTO fact_entity (fact_id, entity_id, mention_count) VALUES (3,1,9),(3,2,5);

    -- Explicit ids above don't advance the SERIAL sequences, so the next
    -- auto-generated id would collide. (The daemon does this same repair on
    -- every boot: "db: resynced N sequence(s) to MAX(id)".)
    SELECT setval('entity_id_seq', (SELECT MAX(id) FROM entity));
    SELECT setval('pod_id_seq', (SELECT MAX(id) FROM pod));
    SELECT setval('fact_id_seq', (SELECT MAX(id) FROM fact));
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse: (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r)),
    wrapIdentifier,
  });
  db.client._injectedPglite = pg;
  vi.doMock('../../db/cortex.js', () => ({ default: db }));
  router = await import('./subject-router.js');
  linker = await import('../facts/entity-linker.js');
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

// The entity list the write path hands in, straight from fact_entity.
const entitiesFor = async (factId) => (await pg.query(
  `SELECT entity_id AS id, mention_count AS "mentionCount" FROM fact_entity
     WHERE fact_id=$1 AND mention_type='content'`, [factId],
)).rows;

const membershipsFor = async (factId) => (await pg.query(
  `SELECT pod_id, role FROM pod_membership WHERE member_type='fact' AND member_id=$1 ORDER BY pod_id`, [factId],
)).rows;

describe('attachFactToEntityPods — subject routing', () => {
  it('files a fact under the project it is ABOUT, not where it was written', async () => {
    const res = await linker.attachFactToEntityPods(1, await entitiesFor(1), db);
    expect(res.attached).toBe(1);
    expect(await membershipsFor(1)).toEqual([{ pod_id: 1, role: 'mention' }]);
  });

  it("uses role 'mention', leaving 'primary' to mean provenance", async () => {
    const [m] = await membershipsFor(1);
    expect(m.role).toBe('mention');
  });

  it('does nothing when no pod is bound to the entity', async () => {
    const res = await linker.attachFactToEntityPods(2, await entitiesFor(2), db);
    expect(res.attached).toBe(0);
    expect(await membershipsFor(2)).toEqual([]);
  });

  it('is idempotent — a re-ingest does not duplicate membership', async () => {
    const before = await membershipsFor(1);
    const res = await linker.attachFactToEntityPods(1, await entitiesFor(1), db);
    expect(res.attached).toBe(0);
    expect(await membershipsFor(1)).toEqual(before);
  });

  it('ranks by mention weight, so the fan-out cap keeps the most-about pods', async () => {
    const res = await linker.attachFactToEntityPods(3, await entitiesFor(3), db);
    // srver (9 mentions) must outrank sigil (5) — that ordering is what the cap
    // relies on once a fact touches more pods than the cap allows.
    expect(res.pods[0]).toBe(1);
    expect(res.attached).toBe(2);
  });
});

describe('bindPodToEntity', () => {
  it('creates and binds an entity for a brand-new project', async () => {
    const id = await router.bindPodToEntity({ podId: 3, name: 'loose', namespace: 'default', db });
    expect(id).toBeGreaterThan(0);
    const [pod] = (await pg.query('SELECT entity_id FROM pod WHERE id=3')).rows;
    expect(pod.entity_id).toBe(id);
  });

  it('never steals an existing binding', async () => {
    expect(await router.bindPodToEntity({ podId: 1, name: 'renamed', namespace: 'default', db })).toBe(1);
  });
});

describe('backfillPodEntityBindings', () => {
  it('binds only to entities that already exist — never invents anchors', async () => {
    await pg.query('UPDATE pod SET entity_id = NULL WHERE id = 2');
    await pg.query("INSERT INTO pod (id, uid, pod_type, name) VALUES (9,'pod-ghost','project','no-such-entity')");
    await pg.query("SELECT setval('pod_id_seq', (SELECT MAX(id) FROM pod))");

    const res = await router.backfillPodEntityBindings({ db });
    expect(res.bound).toBe(1); // sigil rebinds; the ghost has no entity to bind to
    const [sigil] = (await pg.query('SELECT entity_id FROM pod WHERE id=2')).rows;
    const [ghost] = (await pg.query('SELECT entity_id FROM pod WHERE id=9')).rows;
    expect(sigil.entity_id).toBe(2);
    expect(ghost.entity_id).toBeNull();
  });
});

describe('backfillSubjectRouting', () => {
  it('replays the same attachment over facts written before routing existed', async () => {
    await pg.query('DELETE FROM pod_membership');
    const res = await router.backfillSubjectRouting({ db });
    expect(res.scanned).toBe(3);
    // fact 1 -> srver; fact 3 -> srver + sigil; fact 2 -> nothing bound
    expect(res.attached).toBe(3);
    expect(await membershipsFor(2)).toEqual([]);
  });
});
