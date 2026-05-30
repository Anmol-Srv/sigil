/**
 * Shared hook error log — every hook writes failures to a single
 * ~/.sigil/.hook-errors.log file. `sigil doctor` reads this to surface
 * recent failures so problems don't silently rot in production.
 *
 * One line per error, JSON, append-only. Rotated only by manual
 * truncation (it's diagnostic, low-volume, single-machine).
 */

import { appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { SIGIL_HOOK_ERRORS_LOG, SIGIL_LAST_CLEAN_DOCTOR } from '../lib/paths.js';
import { maskSecrets } from './secret-mask.js';

export const HOOK_ERROR_LOG = SIGIL_HOOK_ERRORS_LOG;
export const LAST_CLEAN_DOCTOR_PATH = SIGIL_LAST_CLEAN_DOCTOR;

export async function recordHookError(hook, err, input = null) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      hook,
      // Mask secrets in the error message — provider errors frequently echo
      // the offending key/credential ("Invalid API key: sk-...") and this log
      // is plaintext on disk. The input is already reduced to a hash.
      error: maskSecrets(err?.message || String(err)),
      input_hash: input ? hashInput(input) : null,
    };
    await appendFile(HOOK_ERROR_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Never let log-writing crash a hook
  }
}

// Config gate — every hook calls this at startup. Returns true if the
// hook should bail (config has known-broken combinations like
// EMBEDDING_PROVIDER=voyage + EMBEDDING_MODEL=nomic-embed-text). On
// bail, logs the specific issue + fix command to .hook-errors.log so
// the user sees actionable diagnostics instead of an upstream 4xx.
//
// Returns false (proceed) if the validator import fails — we never
// want validator bugs to block hooks.
export async function failClosedOnBadConfig(hookName, rawInput = null) {
  try {
    const { validateConfig } = await import('../lib/config-validator.js');
    const fails = validateConfig().filter((i) => i.level === 'fail');
    if (fails.length === 0) return false;
    for (const i of fails) {
      const err = new Error(`${i.code}: ${i.message} — fix: ${i.fix}`);
      await recordHookError(hookName, err, rawInput);
    }
    return true;
  } catch {
    return false;
  }
}

export async function readRecentHookErrors(limit = 10) {
  let raw;
  try {
    raw = await readFile(HOOK_ERROR_LOG, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// Count hook errors that arrived AFTER the last clean `sigil doctor` run.
// The user runs doctor → all checks pass → we stamp this file → subsequent
// CLI invocations suppress the proactive warning until a new error arrives.
// This is the proactive surfacing layer: every `sigil <command>` checks
// this and prints a one-line warning if new errors have piled up.
export async function getUnackedErrorCount() {
  let lastClean = 0;
  try {
    const raw = await readFile(LAST_CLEAN_DOCTOR_PATH, 'utf8');
    lastClean = new Date(raw.trim()).getTime();
  } catch {
    // No previous clean doctor; consider all errors unacked
  }

  let raw;
  try {
    raw = await readFile(HOOK_ERROR_LOG, 'utf8');
  } catch {
    return 0;
  }

  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const t = entry.ts ? new Date(entry.ts).getTime() : 0;
      if (t > lastClean) count += 1;
    } catch { /* skip malformed */ }
  }
  return count;
}

// Called by `sigil doctor` when all checks pass — stamps the current
// time so the proactive warning suppresses until new errors arrive.
export async function markDoctorClean() {
  try {
    await writeFile(LAST_CLEAN_DOCTOR_PATH, new Date().toISOString(), 'utf8');
  } catch {
    // Best-effort; if we can't write the ack file, warnings stay on
  }
}

// Manual clear, e.g., if the user wants to reset state without running doctor.
export async function clearLastCleanDoctor() {
  try { await unlink(LAST_CLEAN_DOCTOR_PATH); } catch {}
}

function hashInput(input) {
  try {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return createHash('sha256').update(str).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}
