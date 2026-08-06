// llm_log.model was NOT NULL, which broke the only path that matters when a
// provider is down: llm.js logs the CONFIGURED model on the error path, and for
// a CLI-driven provider (claude-cli, config.llm.model = null) that is null. So
// every successful call was recorded and every FAILED call was dropped by a
// constraint violation — the log went blind exactly when the provider broke.
//
// Runs the real migration against PGlite, so a knex .alter() that doesn't
// actually emit DROP NOT NULL fails here rather than in the field.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from './pglite-adapter.js';
// Import the .cjs migrations directly — Node resolves CJS from ESM natively, so
// this doesn't lean on the test runner's require() interop.
import createTable from './migrations/20260405140000_create-llm-log-table.cjs';
import makeNullable from './migrations/20260806120001_llm-log-model-nullable.cjs';

let pg;
let db;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
  });
  db.client._injectedPglite = pg;
  await createTable.up(db);
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

const insert = (model) => db('llm_log').insert({ provider: 'claude-cli', model, status: 'error', error: 'claude CLI exited 1' });

describe('llm_log.model nullability', () => {
  it('rejects a null model BEFORE the migration (the bug)', async () => {
    await expect(insert(null)).rejects.toThrow(/not-null|null value/i);
  });

  it('accepts a null model after the migration', async () => {
    await makeNullable.up(db);
    await expect(insert(null)).resolves.toBeDefined();
    const [row] = await db('llm_log').where({ provider: 'claude-cli' }).select('model', 'error');
    expect(row.model).toBeNull();
    // The whole point: the failure reason survives.
    expect(row.error).toContain('claude CLI exited 1');
  });

  it('still stores a known model', async () => {
    await expect(insert('haiku')).resolves.toBeDefined();
    const rows = await db('llm_log').whereNotNull('model').select('model');
    expect(rows.map((r) => r.model)).toContain('haiku');
  });

  it('down() backfills so the NOT NULL constraint can be restored', async () => {
    await makeNullable.down(db);
    const nulls = await db('llm_log').whereNull('model');
    expect(nulls).toHaveLength(0);
    const rows = await db('llm_log').where({ model: 'unknown' });
    expect(rows.length).toBeGreaterThan(0);
    await makeNullable.up(db); // leave the table in the migrated state
  });
});
