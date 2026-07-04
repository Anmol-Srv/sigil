// PGlite-backed integration test for P2 owner-scoped read enforcement.
//
// Visibility per pod kind is a contract that, before P2, was stored but never
// enforced at read time: two devices sharing a namespace saw each other's
// `private` (claude_session / person) facts. This test exercises the EXACT
// WHERE-clause fragment produced by filters.buildVisibilityClause against a
// real (in-memory) Postgres engine, over a fact/pod/pod_membership fixture, to
// prove the enforcement rule:
//   - private-kind fact created by device A is hidden from device B
//   - the same fact is visible to device A (its owner)
//   - shared-kind facts are visible to both devices
//   - legacy private facts with created_by_device_id IS NULL are visible to all
//   - SIGIL_PRIVATE_SCOPE=off (no clause emitted) returns everything
//
// No vectors/halfvec here — the visibility predicate is plain SQL on
// fact/pod_membership/pod, so it runs on a bare in-memory PGlite. The clause is
// taken verbatim from buildVisibilityClause; only the `?` placeholders are
// rewritten to PGlite's `$N` form (knex does the same rewrite in production).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { buildVisibilityClause } from './filters.js';

// Device ids are INTEGER PKs (fact.created_by_device_id is an INTEGER FK to
// device.id in the real schema — see migration 20260601000002_add-fact-
// provenance). The fixture mirrors that integer column so the test exercises
// the same int-vs-string coercion path that broke in the field.
const DEVICE_A = 1;
const DEVICE_B = 2;
// A local install identifies itself by the config.json device.id UUID, NOT by
// an integer device PK. Binding this UUID against the INTEGER created_by_device_id
// column is exactly what blew up in the field ("invalid input syntax for type
// integer") before the `::text` cast — this fixture reproduces that path.
const DEVICE_LOCAL_UUID = 'f6ce8926-0000-4000-8000-000000000000';
const PRIVATE_KINDS = ['claude_session', 'person'];

let pg;

// Translate the buildVisibilityClause `?` placeholders into PGlite's positional
// `$1, $2, ...` form. The clause emits exactly two params:
// [currentDeviceId, privateKinds]. The base SELECT below uses none, so the
// clause's first `?` is $1 and so on.
function toPositional(clause, startIndex = 1) {
  let i = startIndex;
  return clause.replace(/\?/g, () => `$${i++}`);
}

// Run "which fact ids are visible" given a resolved privacy scope.
async function visibleIds({ currentDeviceId, scopeEnabled }) {
  const { visibilityClause, visibilityParams } = buildVisibilityClause({
    currentDeviceId,
    privateKinds: PRIVATE_KINDS,
    scopeEnabled,
  });

  const sql = `
    SELECT id FROM fact
    WHERE status = 'active'
      ${toPositional(visibilityClause)}
    ORDER BY id
  `;
  // PGlite needs ::text[] arrays passed as JS arrays; visibilityParams already
  // carries [deviceId, kindsArray] in placeholder order.
  const { rows } = await pg.query(sql, visibilityParams);
  return rows.map((r) => Number(r.id));
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    CREATE TABLE fact (
      id BIGSERIAL PRIMARY KEY,
      content TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_device_id INTEGER
    );
    CREATE TABLE pod (
      id BIGSERIAL PRIMARY KEY,
      pod_type TEXT NOT NULL,
      name TEXT
    );
    CREATE TABLE pod_membership (
      pod_id BIGINT NOT NULL,
      member_type TEXT NOT NULL,
      member_id BIGINT NOT NULL
    );
  `);

  // Pods: one private (claude_session), one shared (project).
  await pg.exec(`
    INSERT INTO pod (id, pod_type, name) VALUES
      (1, 'claude_session', 'session-pod'),
      (2, 'project', 'project-pod');
  `);

  // Facts:
  //   1 — private kind, owned by device A
  //   2 — private kind, owned by device B
  //   3 — private kind, legacy (NULL device)
  //   4 — shared kind, owned by device A
  //   5 — shared kind, legacy (NULL device)
  await pg.exec(`
    INSERT INTO fact (id, content, created_by_device_id) VALUES
      (1, 'A private session note',  ${DEVICE_A}),
      (2, 'B private session note',  ${DEVICE_B}),
      (3, 'legacy private note',     NULL),
      (4, 'A shared project note',   ${DEVICE_A}),
      (5, 'legacy shared note',      NULL);
  `);

  // Membership: facts 1,2,3 belong to the private session pod;
  // facts 4,5 belong to the shared project pod.
  await pg.exec(`
    INSERT INTO pod_membership (pod_id, member_type, member_id) VALUES
      (1, 'fact', 1),
      (1, 'fact', 2),
      (1, 'fact', 3),
      (2, 'fact', 4),
      (2, 'fact', 5);
  `);
});

afterAll(async () => {
  await pg?.close();
});

describe('P2 owner-scoped read enforcement (visibility predicate)', () => {
  it('hides device B’s private fact from device A; keeps A’s own + legacy + shared', async () => {
    const ids = await visibleIds({ currentDeviceId: DEVICE_A, scopeEnabled: true });
    // A sees: its private (1), legacy private (3), shared A (4), legacy shared (5).
    // A does NOT see: B's private (2).
    expect(ids).toEqual([1, 3, 4, 5]);
    expect(ids).not.toContain(2);
  });

  it('hides device A’s private fact from device B; keeps B’s own + legacy + shared', async () => {
    const ids = await visibleIds({ currentDeviceId: DEVICE_B, scopeEnabled: true });
    // B sees: B's private (2), legacy private (3), shared A (4), legacy shared (5).
    // B does NOT see: A's private (1).
    expect(ids).toEqual([2, 3, 4, 5]);
    expect(ids).not.toContain(1);
  });

  it('shared-kind facts are visible to every device regardless of owner', async () => {
    const a = await visibleIds({ currentDeviceId: DEVICE_A, scopeEnabled: true });
    const b = await visibleIds({ currentDeviceId: DEVICE_B, scopeEnabled: true });
    // Fact 4 (shared, owned by A) and 5 (shared, legacy) visible to both.
    expect(a).toEqual(expect.arrayContaining([4, 5]));
    expect(b).toEqual(expect.arrayContaining([4, 5]));
  });

  it('legacy private fact (created_by_device_id IS NULL) is visible to both devices', async () => {
    const a = await visibleIds({ currentDeviceId: DEVICE_A, scopeEnabled: true });
    const b = await visibleIds({ currentDeviceId: DEVICE_B, scopeEnabled: true });
    expect(a).toContain(3);
    expect(b).toContain(3);
  });

  it('SIGIL_PRIVATE_SCOPE=off (scopeEnabled:false) returns everything to every device', async () => {
    const ids = await visibleIds({ currentDeviceId: DEVICE_A, scopeEnabled: false });
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('no current device id resolved → clause skipped → global visibility (fail-open)', async () => {
    const ids = await visibleIds({ currentDeviceId: null, scopeEnabled: true });
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('local install (UUID device id) queries the INTEGER column without coercion error', async () => {
    // This is the field-test regression: created_by_device_id is INTEGER, but
    // the local install's current device id is a UUID. Without the `::text`
    // cast, Postgres coerces the UUID literal to int and throws
    // "invalid input syntax for type integer". With the cast the predicate is
    // type-safe: the UUID matches no integer device row, so EVERY other device's
    // private fact is hidden, while NULL-stamped legacy + shared facts stay
    // visible.
    const ids = await visibleIds({ currentDeviceId: DEVICE_LOCAL_UUID, scopeEnabled: true });
    // Private facts 1 (A) and 2 (B) are hidden (owned by other devices);
    // legacy private 3, shared 4, shared legacy 5 remain visible.
    expect(ids).toEqual([3, 4, 5]);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
  });
});
