/**
 * readEnv / writeEnv — load and persist ~/.sigil/.env.
 *
 * Secrets (anything matching /KEY$|PASSWORD$|TOKEN$|SECRET$/) are returned
 * as `{ masked: true, hasValue: bool }` so the GUI can show "configured"
 * without exposing the value.
 *
 * writeEnv accepts a partial { KEY: 'value', OLD_KEY: null } map. Setting
 * a value to null/undefined removes the key. Other keys in the file are
 * preserved untouched (comments, unknown vars, ordering).
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SIGIL_ENV_PATH } from '../../lib/paths.js';

const SECRET_RE = /(KEY|PASSWORD|TOKEN|SECRET)$/i;

export function registerEnv(registry) {
  registry.register('readEnv', async () => {
    const raw = existsSync(SIGIL_ENV_PATH) ? await readFile(SIGIL_ENV_PATH, 'utf8') : '';
    const entries = parseEnv(raw);
    const out = {};
    for (const [k, v] of Object.entries(entries)) {
      if (SECRET_RE.test(k)) {
        out[k] = { masked: true, hasValue: Boolean(v) };
      } else {
        out[k] = { masked: false, value: v };
      }
    }
    return { path: SIGIL_ENV_PATH, entries: out };
  });

  registry.register('writeEnv', async (params) => {
    const patch = params.patch || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      const err = new Error('writeEnv: params.patch must be an object');
      err.code = 'invalid_params';
      throw err;
    }
    const raw = existsSync(SIGIL_ENV_PATH) ? await readFile(SIGIL_ENV_PATH, 'utf8') : '';
    const next = applyPatch(raw, patch);
    await mkdir(dirname(SIGIL_ENV_PATH), { recursive: true });
    await writeFile(SIGIL_ENV_PATH, next, 'utf8');

    // PR review #19: if a memory-routing env var was touched, drop the
    // cached MemoryClient so the next call rebuilds against the new
    // master / mode. process.env reflects only the daemon's startup
    // values, but the cached client closure is what matters for routing.
    const sensitiveKeys = ['SIGIL_MODE', 'SIGIL_MASTER_NODE_ID', 'SIGIL_NETWORK_ENABLED'];
    if (Object.keys(patch).some((k) => sensitiveKeys.includes(k))) {
      try {
        const { resetMemoryClient } = await import('../../memory/client.js');
        resetMemoryClient();
      } catch { /* ignore */ }
    }

    return { ok: true, path: SIGIL_ENV_PATH, patchedKeys: Object.keys(patch) };
  });
}

function parseEnv(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function applyPatch(raw, patch) {
  const seen = new Set();
  const lines = raw.split('\n');
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/i);
    if (!m) return line;
    const key = m[1];
    if (!(key in patch)) return line;
    seen.add(key);
    const v = patch[key];
    if (v === null || v === undefined) return null;  // marked for removal
    return `${key}=${escapeValue(v)}`;
  }).filter((l) => l !== null);

  // Append new keys that weren't present in the file
  for (const [k, v] of Object.entries(patch)) {
    if (seen.has(k) || v === null || v === undefined) continue;
    next.push(`${k}=${escapeValue(v)}`);
  }

  // Ensure trailing newline
  let out = next.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function escapeValue(v) {
  const s = String(v);
  if (/[\s#"'$]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}
