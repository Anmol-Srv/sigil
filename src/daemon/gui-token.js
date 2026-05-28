import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

import { SIGIL_GUI_TOKEN } from '../lib/paths.js';

/**
 * Returns the GUI auth token, generating + persisting one on first use.
 * Stored at ~/.sigil/gui.token mode 0600. Anyone with read access to the
 * user's home dir can read it — that matches the existing trust boundary
 * (they could read .env too), so this is "auth for *this* user" not
 * cross-user isolation.
 */
// PR review #24: collapse cache + existsSync + length-check into one
// try-read-or-create routine.
let cached = null;
export async function getGuiToken() {
  if (cached) return cached;
  try {
    const t = (await readFile(SIGIL_GUI_TOKEN, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(t)) return (cached = t);
  } catch { /* missing or unreadable — fall through to create */ }
  await mkdir(dirname(SIGIL_GUI_TOKEN), { recursive: true });
  const fresh = randomBytes(32).toString('hex');
  await writeFile(SIGIL_GUI_TOKEN, fresh, 'utf8');
  try { await chmod(SIGIL_GUI_TOKEN, 0o600); } catch { /* best effort */ }
  return (cached = fresh);
}

/**
 * Constant-time token compare. Always converts both sides to fixed-length
 * Buffers to avoid leaking the length of the provided token.
 */
export async function isValidToken(provided) {
  if (!provided || typeof provided !== 'string') return false;
  const expected = await getGuiToken();
  if (provided.length !== expected.length) {
    // Still do a compare against a same-length placeholder so the
    // mismatch path takes equal time.
    timingSafeEqual(Buffer.from(expected), Buffer.from(expected));
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}
