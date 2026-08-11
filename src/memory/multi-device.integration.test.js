// The two scenarios multi-device memory exists to serve, run against a real
// Postgres (PGlite) with the real migration and the real WHERE clause.
//
//   1. The cloud agent finds a bug and writes it down. The laptop agent, asked
//      later to hunt GUI issues in a DIFFERENT namespace, must find it.
//   2. The cloud agent is told "call me sir". The laptop agent must NOT find
//      it, or it starts saying sir in a conversation the user never had.
//
// Both are one SQL predicate away from each other, which is exactly why this
// is an integration test and not a unit test: the unit tests pin the clause
// text, and this pins that the clause actually selects the right rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../db/pglite-adapter.js';
import { buildVisibilityFilter } from './search/filters.js';
import { scopeVisibility } from './visibility.js';

let pg;
let db;

// Mirror cortex.js: snake_case on the wire, camelCase in JS.
const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const postProcessResponse = (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r));
const wrapIdentifier = (value, orig) => orig(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

// The two installs sharing one database.
const CLOUD = 1;   // where hermes runs
const LAPTOP = 2;  // where claude runs

// Who is reading. This is what a daemon assembles from the request context.
const asHermes = { agent: 'hermes', deviceId: CLOUD };
const asClaude = { agent: 'claude-code', deviceId: LAPTOP };
const asHuman = null; // `sigil search` — no scoping at all

// Namespaces are deliberately DIFFERENT per agent. Cross-namespace retrieval
// is the requirement; a design that only works when both agents happen to
// share a namespace hasn't solved anything.
const BOTH_NAMESPACES = ['hermes-work', 'sigil'];

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    CREATE TABLE device (
      id BIGSERIAL PRIMARY KEY,
      node_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );
    CREATE TABLE fact (
      id BIGSERIAL PRIMARY KEY,
      uid TEXT,
      content TEXT NOT NULL,
      category TEXT,
      confidence TEXT NOT NULL DEFAULT 'high',
      importance TEXT NOT NULL DEFAULT 'supplementary',
      status TEXT NOT NULL DEFAULT 'active',
      namespace TEXT NOT NULL DEFAULT 'default',
      created_by_device_id BIGINT,
      created_by_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    INSERT INTO device (id, node_id, name) VALUES
      (1, 'aa11', 'cloud-box'), (2, 'bb22', 'laptop');
  `);

  // The instance is injected AFTER construction, not passed inside
  // `connection`: knex deep-clones its config, and deep-cloning a live PGlite
  // instance throws. Same shape the other PGlite integration tests use.
  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse,
    wrapIdentifier,
  });
  db.client._injectedPglite = pg;

  // Run the REAL migration, not a hand-written approximation of it. If the
  // CHECK constraint or the partial index is invalid SQL, this test is where
  // that surfaces — not on a user's database during `sigil update`.
  const migration = await import('../db/migrations/20260811130000_add-fact-visibility.cjs');
  await migration.default.up(db);
});

afterAll(async () => {
  await db?.destroy();
  await pg?.close();
});

/** Exactly what hybrid-sql/vector/keyword do: interpolate clause, splat params. */
async function visibleTo(viewer, { namespaces = BOTH_NAMESPACES } = {}) {
  const { clause, params } = buildVisibilityFilter(viewer);
  const { rows } = await db.raw(
    `SELECT content FROM fact
     WHERE namespace = ANY(?) AND status = 'active' ${clause}
     ORDER BY id`,
    [namespaces, ...params],
  );
  return rows.map((r) => r.content);
}

describe('the migration itself', () => {
  it('defaults every pre-existing fact to shared, so nothing disappears on upgrade', async () => {
    // A row inserted with no visibility at all — i.e. every row that existed
    // before this column did.
    const [row] = await db('fact')
      .insert({ uid: 'legacy', content: 'a fact from before visibility existed', namespace: 'sigil' })
      .returning(['visibility']);
    expect(row.visibility).toBe('shared');
  });

  it('refuses a visibility value the read path cannot interpret', async () => {
    // Without the CHECK, a typo'd value matches no branch of the WHERE clause
    // and the fact becomes invisible to everyone, silently and forever.
    await expect(
      db('fact').insert({ uid: 'bogus', content: 'x', namespace: 'sigil', visibility: 'private' }),
    ).rejects.toThrow();
  });
});

describe('scenario 1 — the cloud agent finds a bug, the laptop agent picks it up', () => {
  beforeAll(async () => {
    await db('fact').insert({
      uid: 'fact-bug',
      content: 'The Sigil GUI entity list leaks entities from other namespaces',
      category: 'issue',
      namespace: 'hermes-work',        // hermes' namespace...
      created_by_device_id: CLOUD,
      created_by_agent: 'hermes',
      visibility: 'shared',
    });
  });

  it('reaches the other device, the other agent, and the other namespace', async () => {
    const seen = await visibleTo(asClaude);
    expect(seen).toContain('The Sigil GUI entity list leaks entities from other namespaces');
  });

  it('is still visible to the agent that wrote it', async () => {
    const seen = await visibleTo(asHermes);
    expect(seen).toContain('The Sigil GUI entity list leaks entities from other namespaces');
  });

  it('still respects namespace when the caller asks for one namespace', async () => {
    // Visibility widens across devices; it must not quietly widen across
    // namespaces the caller didn't ask for. Those are separate axes.
    const seen = await visibleTo(asClaude, { namespaces: ['sigil'] });
    expect(seen).not.toContain('The Sigil GUI entity list leaks entities from other namespaces');
  });
});

describe('scenario 2 — "call me sir" stays with the agent it was said to', () => {
  beforeAll(async () => {
    await db('fact').insert({
      uid: 'fact-sir',
      content: 'User wants to be called sir',
      category: 'preference',
      importance: 'vital',            // exactly how the extractor rates it
      namespace: 'hermes-work',
      created_by_device_id: CLOUD,
      created_by_agent: 'hermes',
      visibility: 'agent',
    });
  });

  it('does NOT reach the other agent', async () => {
    const seen = await visibleTo(asClaude);
    expect(seen).not.toContain('User wants to be called sir');
  });

  it('DOES reach the agent it was told to — it is not lost, just scoped', async () => {
    const seen = await visibleTo(asHermes);
    expect(seen).toContain('User wants to be called sir');
  });

  it('is visible to the human, who owns all of it', async () => {
    const seen = await visibleTo(asHuman);
    expect(seen).toContain('User wants to be called sir');
  });

  it('stays private even when the same agent runs on a different device', async () => {
    // The persona boundary is the AGENT, not the machine. Hermes moved to a
    // new box is still hermes and should keep its own instructions.
    const hermesElsewhere = { agent: 'hermes', deviceId: 999 };
    expect(await visibleTo(hermesElsewhere)).toContain('User wants to be called sir');
  });
});

describe('device-scoped facts', () => {
  beforeAll(async () => {
    await db('fact').insert({
      uid: 'fact-path',
      content: 'The sigil checkout lives at /workspace/sigil',
      category: 'domain_knowledge',
      namespace: 'hermes-work',
      created_by_device_id: CLOUD,
      created_by_agent: 'hermes',
      visibility: 'device',
    });
  });

  it('does not follow the agent to another machine — the path is not true there', async () => {
    const hermesOnLaptop = { agent: 'hermes', deviceId: LAPTOP };
    expect(await visibleTo(hermesOnLaptop)).not.toContain('The sigil checkout lives at /workspace/sigil');
  });

  it('is visible to any agent on the machine it describes', async () => {
    const someoneElseOnCloud = { agent: 'codex', deviceId: CLOUD };
    expect(await visibleTo(someoneElseOnCloud)).toContain('The sigil checkout lives at /workspace/sigil');
  });
});

describe('back-compat with un-attributed rows', () => {
  beforeAll(async () => {
    // Every fact written before self-registration existed looks like this.
    await db('fact').insert({
      uid: 'fact-orphan',
      content: 'an old fact with no provenance at all',
      namespace: 'sigil',
      created_by_device_id: null,
      created_by_agent: null,
      visibility: 'shared',
    });
  });

  it('stays visible to everyone — an upgrade must not shrink recall', async () => {
    for (const viewer of [asClaude, asHermes, asHuman]) {
      expect(await visibleTo(viewer)).toContain('an old fact with no provenance at all');
    }
  });
});

describe('the knex path agrees with the raw-SQL path', () => {
  it('hides the same rows via scopeVisibility as via buildVisibilityFilter', async () => {
    // hot-context uses the query builder; search uses raw SQL. If these two
    // ever disagree, a fact hidden from search still gets injected straight
    // into the agent's prompt — the louder of the two channels.
    const viaKnex = await scopeVisibility(
      db('fact').where({ status: 'active' }).whereIn('namespace', BOTH_NAMESPACES),
      asClaude,
      'fact',
    ).orderBy('id').pluck('content');

    expect(viaKnex).toEqual(await visibleTo(asClaude));
  });

  it('and both let everything through for a null viewer', async () => {
    const viaKnex = await scopeVisibility(
      db('fact').where({ status: 'active' }).whereIn('namespace', BOTH_NAMESPACES),
      asHuman,
      'fact',
    ).orderBy('id').pluck('content');

    expect(viaKnex).toEqual(await visibleTo(asHuman));
  });
});
