/**
 * Schema Manifest — single source of truth for cross-device embedding
 * + extraction consistency.
 *
 * Produced by master at pair time, sent to follower, verified before
 * the follower is allowed to actually exchange facts. Mismatches are
 * fatal: a mixed-model cluster silently corrupts vector search, so we
 * refuse rather than degrade.
 *
 * Manifest contents:
 *   schema       — knex migration state, required Postgres extensions
 *   embedding    — provider/model/dim/normalization
 *   chunker      — version/size/overlap/contextual_prefix flag
 *   prompts      — sha256 of each prompt template (extraction, AUDM,
 *                  classifier, etc.) so follower can detect drift
 *   memory       — AUDM thresholds + similarity floor
 *   sigilVersion — informational; not strict-enforced
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PKG_ROOT, MIGRATIONS_DIR } from '../lib/paths.js';
import config from '../config.js';
import { CHUNKER_PROFILE } from '../ingestion/chunker.js';

export const MANIFEST_VERSION = 1;

let cachedSigilVersion;
function getSigilVersion() {
  if (cachedSigilVersion) return cachedSigilVersion;
  try {
    cachedSigilVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch { cachedSigilVersion = 'unknown'; }
  return cachedSigilVersion;
}

export async function produceManifest() {
  const promptHashes = await hashPromptDir(join(PKG_ROOT, 'prompts'));

  // Migration version = the highest applied knex migration file. We read
  // from the local migrations dir since they're the schema *we* know how
  // to apply; the remote will compare to its own dir.
  const migrationVersion = await highestMigrationFile();

  return {
    v: MANIFEST_VERSION,
    producedAt: new Date().toISOString(),
    sigilVersion: getSigilVersion(),
    schema: {
      migrationVersion,
      requiredExtensions: ['vector'],
    },
    embedding: {
      provider: config.embedding.provider || null,
      model: config.embedding.model || null,
      dimensions: Number(config.embedding.dimensions) || null,
      normalization: 'l2',
      // PR review #28: nominal upper bound — embedder doesn't currently
      // export a canonical constant. Bump together with the underlying
      // provider tokenizer limits when those change.
      maxInputTokens: 8192,
    },
    // Sourced from the chunker module so the manifest cannot drift
    // from the values the chunker actually uses. (PR review #4.)
    chunker: { ...CHUNKER_PROFILE },
    prompts: promptHashes,
    memory: {
      skipThreshold: config.memory.skipThreshold,
      ambiguousThreshold: config.memory.ambiguousThreshold,
      minFactSimilarity: config.memory.minFactSimilarity,
    },
  };
}

/**
 * Returns { ok, errors:[], warnings:[] }.
 *
 * Strict (must match → ok=false on diff): embedding.{provider,model,dimensions},
 *                                          chunker.{size,overlap,version},
 *                                          memory.skipThreshold, schema.migrationVersion
 * Soft  (warning only): prompts, sigilVersion, normalization
 */
export function verifyManifest(local, remote) {
  const errors = [];
  const warnings = [];
  if (!remote || remote.v !== MANIFEST_VERSION) {
    errors.push(`manifest version mismatch (local v${local.v} vs remote v${remote?.v ?? '?'})`);
    return { ok: false, errors, warnings };
  }

  // Embedding shape — must match exactly
  for (const k of ['provider', 'model', 'dimensions']) {
    if (local.embedding[k] !== remote.embedding[k]) {
      errors.push(`embedding.${k}: local=${local.embedding[k]} vs remote=${remote.embedding[k]}`);
    }
  }

  // Chunker shape — must match exactly
  for (const k of ['version', 'size', 'overlap']) {
    if (local.chunker[k] !== remote.chunker[k]) {
      errors.push(`chunker.${k}: local=${local.chunker[k]} vs remote=${remote.chunker[k]}`);
    }
  }

  // Schema migration version — if either side is ahead, refuse and tell
  // the user to run migrations on the follower (typically).
  if (local.schema.migrationVersion !== remote.schema.migrationVersion) {
    errors.push(
      `schema.migrationVersion: local=${local.schema.migrationVersion} vs remote=${remote.schema.migrationVersion} `
      + '(run `sigil migrate` on this device, or upgrade master)',
    );
  }

  // AUDM thresholds — small drift is soft; large drift is hard
  if (Math.abs(local.memory.skipThreshold - remote.memory.skipThreshold) > 0.01) {
    errors.push(`memory.skipThreshold differs: local=${local.memory.skipThreshold} vs remote=${remote.memory.skipThreshold}`);
  }
  if (Math.abs(local.memory.ambiguousThreshold - remote.memory.ambiguousThreshold) > 0.05) {
    warnings.push(`memory.ambiguousThreshold drift: local=${local.memory.ambiguousThreshold} vs remote=${remote.memory.ambiguousThreshold}`);
  }

  // Prompt hashes — soft; new ingests will diverge in extraction style
  // but old facts remain searchable
  for (const k of Object.keys(local.prompts)) {
    if (remote.prompts[k] && local.prompts[k] !== remote.prompts[k]) {
      warnings.push(`prompt "${k}" differs (new ingests will produce different facts)`);
    }
  }

  if (local.sigilVersion !== remote.sigilVersion) {
    warnings.push(`sigil version drift: local=${local.sigilVersion} vs remote=${remote.sigilVersion}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

async function hashPromptDir(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const files = await readdir(dir);
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const content = await readFile(join(dir, f), 'utf8');
    out[f.replace(/\.md$/, '')] = sha256(content);
  }
  return out;
}

async function highestMigrationFile() {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  const files = await readdir(MIGRATIONS_DIR);
  const stamps = files
    .filter((f) => /^\d{14}_.+\.cjs$/.test(f))
    .map((f) => f.replace(/_.+\.cjs$/, ''))
    .sort();
  return stamps[stamps.length - 1] ?? null;
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
