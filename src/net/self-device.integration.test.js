// Two installs sharing one database have to end up as two distinct, stable
// rows in `device`. If they collide, every fact looks like it came from the
// same machine and device-scoped visibility silently does nothing. If they
// churn — a new row per restart — the `device` table grows without bound and
// yesterday's facts point at a device that no longer describes anything.
//
// This exercises the real upsert against a real Postgres, with two real
// identity keys, because both failure modes are in the SQL rather than the JS.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ClientPGlite } from '../db/pglite-adapter.js';

let pg;
let db;
let dir;

const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const postProcessResponse = (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r));
const wrapIdentifier = (value, orig) => orig(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

// Load identity.js + self-device.js with SIGIL_IDENTITY_KEY pointed at a
// specific file, so one test process can impersonate several installs.
async function installAt(keyPath) {
  vi.resetModules();
  vi.doMock('../lib/paths.js', async (orig) => ({
    ...(await orig()),
    SIGIL_IDENTITY_KEY: keyPath,
  }));
  vi.doMock('../db/cortex.js', () => ({ default: db }));
  const identity = await import('./identity.js');
  const selfDevice = await import('./self-device.js');
  identity.resetIdentityCache();
  selfDevice.resetSelfDevice();
  return { identity, selfDevice };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sigil-identity-'));
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE TABLE device (
      id BIGSERIAL PRIMARY KEY,
      node_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'writer',
      namespaces TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      meta JSONB NOT NULL DEFAULT '{}',
      last_seen_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
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
});

afterAll(async () => {
  vi.resetModules();
  await db?.destroy();
  await pg?.close();
});

describe('public key derivation', () => {
  it('is deterministic — the same seed is the same device forever', async () => {
    const keyPath = join(dir, 'stable.key');
    await writeFile(keyPath, randomBytes(32).toString('hex'));

    const a = await installAt(keyPath);
    const first = await a.identity.getPublicKeyHex();
    const b = await installAt(keyPath);   // fresh module graph, same file
    expect(await b.identity.getPublicKeyHex()).toBe(first);
  });

  it('produces a 64-hex-char key, the shape node_id stores', async () => {
    const keyPath = join(dir, 'shape.key');
    await writeFile(keyPath, randomBytes(32).toString('hex'));
    const { identity } = await installAt(keyPath);
    expect(await identity.getPublicKeyHex()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different installs different identities', async () => {
    const p1 = join(dir, 'one.key');
    const p2 = join(dir, 'two.key');
    await writeFile(p1, randomBytes(32).toString('hex'));
    await writeFile(p2, randomBytes(32).toString('hex'));

    const k1 = await (await installAt(p1)).identity.getPublicKeyHex();
    const k2 = await (await installAt(p2)).identity.getPublicKeyHex();
    expect(k1).not.toBe(k2);
  });
});

describe('self-registration in a shared database', () => {
  it('creates one row per install, not one per restart', async () => {
    const keyPath = join(dir, 'restart.key');
    await writeFile(keyPath, randomBytes(32).toString('hex'));

    const first = await (await installAt(keyPath)).selfDevice.ensureSelfDevice();
    const second = await (await installAt(keyPath)).selfDevice.ensureSelfDevice();
    const third = await (await installAt(keyPath)).selfDevice.ensureSelfDevice();

    expect(first.id).toBe(second.id);
    expect(second.id).toBe(third.id);

    const rows = await db('device').where({ nodeId: first.nodeId });
    expect(rows).toHaveLength(1);
  });

  it('gives two installs sharing the database two distinct device ids', async () => {
    const cloudKey = join(dir, 'cloud.key');
    const laptopKey = join(dir, 'laptop.key');
    await writeFile(cloudKey, randomBytes(32).toString('hex'));
    await writeFile(laptopKey, randomBytes(32).toString('hex'));

    const cloud = await (await installAt(cloudKey)).selfDevice.ensureSelfDevice();
    const laptop = await (await installAt(laptopKey)).selfDevice.ensureSelfDevice();

    // The whole point: without this, every fact from both machines carries the
    // same (or no) device id and device-scoped visibility is a no-op.
    expect(cloud.id).not.toBe(laptop.id);
    expect(cloud.nodeId).not.toBe(laptop.nodeId);
  });

  it('does not restore access for a device that was revoked', async () => {
    // A device paired into a cluster and then revoked must not un-revoke
    // itself by restarting. The upsert deliberately does not merge
    // active/role/namespaces for exactly this reason.
    const keyPath = join(dir, 'revoked.key');
    await writeFile(keyPath, randomBytes(32).toString('hex'));

    const before = await (await installAt(keyPath)).selfDevice.ensureSelfDevice();
    await db('device').where({ id: before.id }).update({ active: false, role: 'reader' });

    await (await installAt(keyPath)).selfDevice.ensureSelfDevice();

    const [row] = await db('device').where({ id: before.id });
    expect(row.active).toBe(false);
    expect(row.role).toBe('reader');
  });

  it('refuses to start on a corrupt key rather than minting a new identity', async () => {
    // Overwriting would orphan every fact already attributed to the real key.
    const keyPath = join(dir, 'corrupt.key');
    await writeFile(keyPath, 'not-a-hex-key');
    const { identity } = await installAt(keyPath);
    await expect(identity.getPublicKeyHex()).rejects.toThrow(/malformed/i);
  });

  it('survives an unreachable database by returning null, not throwing', async () => {
    // Provenance is worth having, never worth refusing to boot for.
    vi.resetModules();
    vi.doMock('../lib/paths.js', async (orig) => ({
      ...(await orig()),
      SIGIL_IDENTITY_KEY: join(dir, 'nodb.key'),
    }));
    vi.doMock('../db/cortex.js', () => ({
      default: () => { throw new Error('ECONNREFUSED'); },
    }));
    await writeFile(join(dir, 'nodb.key'), randomBytes(32).toString('hex'));
    const selfDevice = await import('./self-device.js');
    selfDevice.resetSelfDevice();
    expect(await selfDevice.ensureSelfDevice()).toBeNull();
    expect(selfDevice.selfDeviceId()).toBeNull();
  });
});
