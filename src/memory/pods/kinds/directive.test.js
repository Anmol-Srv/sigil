// The failure this pins: a user states a standing preference ("keep answers
// short"), it is saved correctly, and the assistant goes on ignoring it —
// because recall is query-driven and no prompt ever looks semantically like
// the preference. The always-on hot-context block is the fix, and before the
// directive kind its slots were owned by whatever had been ingested most
// recently from any project.
//
// Run against a real Postgres because the selection is entirely a WHERE
// clause plus an ORDER BY, and both are the thing under test.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../../db/pglite-adapter.js';

let pg;
let db;
let directiveKind;

const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const postProcessResponse = (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r));
const wrapIdentifier = (value, orig) => orig(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

const NS = 'default';

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE TABLE fact (
      id BIGSERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT,
      namespace TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'active',
      importance TEXT,
      importance_score INT,
      visibility TEXT NOT NULL DEFAULT 'shared',
      created_by_agent TEXT,
      created_by_device_id BIGINT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse,
    wrapIdentifier,
  });
  db.client._injectedPglite = pg;

  vi.resetModules();
  vi.doMock('../../../db/cortex.js', () => ({ default: db }));
  ({ directiveKind } = await import('./directive.js'));
});

afterAll(async () => {
  vi.resetModules();
  await db?.destroy();
  await pg?.close();
});

// Insert with an explicit created_at so ordering is deterministic rather than
// dependent on how fast the test machine runs.
async function seed(rows) {
  await db('fact').del();
  await db('fact').insert(rows.map((r, i) => ({
    content: r.content,
    category: r.category,
    namespace: r.namespace ?? NS,
    status: 'active',
    importance: r.importance ?? 'supplementary',
    visibility: r.visibility ?? 'shared',
    created_by_agent: r.agent ?? null,
    created_at: new Date(Date.UTC(2026, 0, 1 + i)),
  })));
}

const fetch = (slots = 5) => directiveKind.fetchFacts({ namespace: NS }, { slots, namespace: NS });

describe('directive selection', () => {
  it('picks up how-to-work-with-me facts and leaves project trivia behind', async () => {
    // The exact shape of the reported bug: four ingested project facts and one
    // standing preference. Before this kind, recency alone put the preference
    // last and the block filled with the other four.
    await seed([
      { content: 'Anmol prefers short, crisp explanations', category: 'preference' },
      { content: 'PAYMENT-SHEET-SYNC.md documents the sheet sync', category: 'architecture' },
      { content: 'Landing page 185 tolerates 5 unsynced rows', category: 'business_rule' },
      { content: 'The isDuplicated column is database-only', category: 'convention' },
      { content: 'Chunker splits on heading boundaries', category: 'domain_knowledge' },
    ]);

    const facts = await fetch();
    expect(facts).toContain('Anmol prefers short, crisp explanations');
    expect(facts).not.toContain('PAYMENT-SHEET-SYNC.md documents the sheet sync');
    expect(facts).not.toContain('Chunker splits on heading boundaries');
  });

  it('excludes workflow, which is project mechanics despite the name', async () => {
    await seed([
      { content: 'Registration sync flushes uid cells every 100 rows', category: 'workflow' },
      { content: 'User prefers named exports', category: 'preference' },
    ]);
    expect(await fetch()).toEqual(['User prefers named exports']);
  });

  it('keeps personal and opinion facts, which are user-level too', async () => {
    await seed([
      { content: "User's name is Anmol", category: 'personal' },
      { content: 'User rates Postgres over Mongo for this workload', category: 'opinion' },
    ]);
    expect(await fetch()).toHaveLength(2);
  });
});

describe('directive ordering', () => {
  it('lets a correction beat the preference it corrects', async () => {
    // Newest wins. If this ordering flips, "actually, keep it short" loses to
    // the older instruction it was issued to override — and the user has to
    // repeat themselves, which is the whole complaint.
    await seed([
      { content: 'User likes thorough, detailed walkthroughs', category: 'preference' },
      { content: 'User wants short answers, not walls of text', category: 'preference' },
    ]);
    const facts = await fetch(1);
    expect(facts).toEqual(['User wants short answers, not walls of text']);
  });

  it('honours the slot budget', async () => {
    await seed(Array.from({ length: 12 }, (_, i) => ({
      content: `preference number ${i}`,
      category: 'preference',
    })));
    expect(await fetch(5)).toHaveLength(5);
  });
});

describe('directive scoping', () => {
  it('does not leak another agent-scoped instruction into this prompt', async () => {
    // A directive is written straight into an agent's prompt, so this is the
    // path that most needs the visibility check: "call me sir" told to hermes
    // must not make claude say sir.
    await seed([
      { content: 'User wants to be called sir', category: 'preference', visibility: 'agent', agent: 'hermes' },
      { content: 'User prefers tabs', category: 'preference' },
    ]);

    process.env.SIGIL_AGENT = 'claude-code';
    const facts = await fetch();
    delete process.env.SIGIL_AGENT;

    expect(facts).toContain('User prefers tabs');
    expect(facts).not.toContain('User wants to be called sir');
  });

  it('stays inside the namespace it was asked for', async () => {
    await seed([
      { content: 'in-namespace preference', category: 'preference' },
      { content: 'other-namespace preference', category: 'preference', namespace: 'elsewhere' },
    ]);
    expect(await fetch()).toEqual(['in-namespace preference']);
  });
});
