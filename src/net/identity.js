/**
 * Persistent device identity.
 *
 * A single Ed25519 secret key, generated once and persisted at
 *   ~/.sigil/identity.key  (mode 0600, 64 hex chars = 32 bytes).
 *
 * The matching public key IS the device's NodeID — the same value that
 * the device table stores and that authorization checks against. There
 * is no separation between "transport identity" and "data identity": one
 * keypair covers Iroh QUIC TLS, the device row primary key, and (later)
 * outbox event signatures.
 *
 * If the file is missing on startup, a fresh keypair is created. If it
 * exists but is malformed, we refuse to start — never silently overwrite
 * what could be a real device's identity.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { SIGIL_IDENTITY_KEY } from '../lib/paths.js';

const SECRET_BYTES = 32;

let cachedSecret = null;

/**
 * Returns the 32-byte Ed25519 secret key as a number[] (Iroh's NAPI
 * shape). Creates + persists a fresh key on first call.
 */
export async function getSecretKey() {
  if (cachedSecret) return cachedSecret;

  if (existsSync(SIGIL_IDENTITY_KEY)) {
    const raw = (await readFile(SIGIL_IDENTITY_KEY, 'utf8')).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        `identity: ${SIGIL_IDENTITY_KEY} is malformed (expected 64 hex chars). `
        + 'Refusing to overwrite — move or delete the file manually to regenerate.',
      );
    }
    // PR review #23: Buffer.from(hex,'hex') + Array.from is the same
    // thing in two well-tested lines instead of 13 hand-rolled ones.
    cachedSecret = Array.from(Buffer.from(raw, 'hex'));
    return cachedSecret;
  }

  await mkdir(dirname(SIGIL_IDENTITY_KEY), { recursive: true });
  const buf = randomBytes(SECRET_BYTES);
  await writeFile(SIGIL_IDENTITY_KEY, buf.toString('hex'), 'utf8');
  try { await chmod(SIGIL_IDENTITY_KEY, 0o600); } catch { /* best effort */ }
  cachedSecret = Array.from(buf);
  return cachedSecret;
}
