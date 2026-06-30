/**
 * Config store — the device-local source of truth that replaces ~/.sigil/.env.
 *
 * Design (decisions from the onboarding redesign):
 *   - ONE versioned JSON file at ~/.sigil/config.json, chmod 600.
 *   - The file is SPARSE: it holds only values that were explicitly set.
 *     Defaults live in code (defaults() below) and are merged in at READ time,
 *     so defaults always track the code instead of freezing into the file —
 *     the exact failure mode that made stale .env files break upgrades.
 *   - schemaVersion + ordered migrations run on load; unknown keys are dropped.
 *   - Single writer with atomic write (tmp + rename). The in-memory cache is
 *     updated on every patch so the daemon sees fresh values without a restart.
 *
 * This is device-local only. Shared memory data lives in Postgres; the DB
 * connection itself can't live in the DB (chicken-and-egg), so it lives here.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SIGIL_CONFIG_PATH, SIGIL_ENV_PATH } from '../lib/paths.js';
import { EMBEDDING_DIM } from '../lib/constants.js';

export const CONFIG_SCHEMA_VERSION = 2;

const DB_MODES = ['embedded', 'local', 'docker', 'url'];
const STEP_STATUSES = ['pending', 'active', 'done', 'error'];

/**
 * Code-owned defaults. The on-disk file overlays a SPARSE subset of this; never
 * write the whole tree out. Embedding dimension is intentionally absent — it's
 * a build-time constant (EMBEDDING_DIM), not config.
 */
function defaults() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    device: { id: null },
    database: {
      mode: null,            // 'embedded' | 'local' | 'docker' | 'url'
      url: null,
      host: 'localhost',
      port: 5432,
      name: 'sigil',
      user: 'sigil_app',
      password: null,
    },
    // llm: provider identity (set by onboarding) + tuning knobs and the
    // managed-session engine. config.json is the sole source of truth — these
    // were env-only before (LLM_*, SIGIL_MANAGED_*, SIGIL_MAX_CLAUDE_PROCS).
    llm: {
      provider: null, model: null, apiKey: null, host: null,
      cliPath: '',
      extractionModel: '', decisionModel: '', entityModel: '',
      maxRetries: 3, cliTimeout: 120000, requestTimeout: 60000, maxClaudeProcs: 4,
      openrouterBaseUrl: '', openrouterReferer: 'https://github.com/Anmol-Srv/sigil', openrouterTitle: 'Sigil',
      managedSession: {
        enabled: false, poolSize: 1, tokenBudget: 60000,
        taskTimeoutMs: 120000, firstTaskTimeoutMs: 10000, healthProbeMs: 15000,
        clearBetweenTasks: true,
      },
    },
    embedding: {
      provider: null, model: null, apiKey: null, host: null,
      openrouterBaseUrl: '', openrouterReferer: 'https://github.com/Anmol-Srv/sigil', openrouterTitle: 'Sigil',
    },
    identity: { name: null },
    // Infra/tuning — prepopulated here (defaults track the code, merged on read)
    // so config.json is self-sufficient and no env file is consulted.
    http: { enabled: true, host: '127.0.0.1', port: 7777 },
    network: { mode: 'solo', enabled: false, masterNodeId: null },
    defaults: { namespace: 'default' },
    memory: {
      skipThreshold: 0.88, ambiguousThreshold: 0.78, supersedeThreshold: 0.72,
      supersedeScanLimit: 8, minFactSimilarity: 0.45, injectionFloor: 0.6,
    },
    search: { synthesize: true, synthesizeModel: '' },
    ingest: { eagerExtract: true, extractRelations: true, graphGleanRounds: 0 },
    output: {
      storage: 'local', dir: './output',
      s3: { endpoint: '', bucket: '', region: 'us-east-1', accessKey: '', secretKey: '', publicUrl: '' },
    },
    hebbian: {
      entity: {
        enabled: true, eta: 1, cap: 50, halfLifeDays: 30, minEffective: 0.5,
        rrfWeight: 0.3, maxWriteEntities: 12, expandPerSeed: 3,
      },
    },
    preferences: { noUpdateCheck: false },
    setup: { complete: false, steps: {} },
  };
}

// Ordered migrations keyed by the version they upgrade *to*. Each receives the
// raw parsed file and returns the upgraded shape. None yet (v1 is the floor).
const MIGRATIONS = {
  // 2: (raw) => ({ ...raw, schemaVersion: 2, /* ... */ }),
};

// ── internal helpers ────────────────────────────────────────────────────────

let cache = null; // merged (defaults ⊕ file) snapshot

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge `overlay` onto `base` (objects merge per-key; scalars/arrays replace). */
function deepMerge(base, overlay) {
  if (!isPlainObject(overlay)) return overlay;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Read the sparse on-disk object (no defaults). Returns {} if absent/corrupt. */
function readRaw() {
  if (!existsSync(SIGIL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SIGIL_CONFIG_PATH, 'utf8')) || {};
  } catch {
    // A corrupt config is a hard error class, but reads must not crash the
    // daemon — treat as empty and let setup rewrite it.
    return {};
  }
}

function runMigrations(raw) {
  let cur = raw;
  let v = Number(cur.schemaVersion) || 1;
  while (v < CONFIG_SCHEMA_VERSION) {
    const next = v + 1;
    const fn = MIGRATIONS[next];
    cur = fn ? fn(cur) : { ...cur, schemaVersion: next };
    v = next;
  }
  return cur;
}

/** Keep only keys that exist in defaults() — silently drop unknowns. */
function pruneUnknown(sparse) {
  const d = defaults();
  const out = {};
  for (const section of Object.keys(d)) {
    if (!(section in sparse)) continue;
    if (!isPlainObject(d[section])) { out[section] = sparse[section]; continue; }
    const sub = {};
    for (const key of Object.keys(d[section])) {
      if (sparse[section] && key in sparse[section]) sub[key] = sparse[section][key];
    }
    // setup.steps is an open map (one key per step) — preserve it wholesale.
    if (section === 'setup' && isPlainObject(sparse.setup?.steps)) sub.steps = sparse.setup.steps;
    out[section] = sub;
  }
  return out;
}

function atomicWrite(sparse) {
  mkdirSync(dirname(SIGIL_CONFIG_PATH), { recursive: true });
  const tmp = `${SIGIL_CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sparse, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, SIGIL_CONFIG_PATH);
  try { chmodSync(SIGIL_CONFIG_PATH, 0o600); } catch { /* best-effort on platforms w/o chmod */ }
}

// ── validation (on WRITE; reads stay tolerant) ───────────────────────────────

function validateSection(section, values) {
  const errors = {};
  if (!isPlainObject(values)) throw new Error(`config patch for "${section}" must be an object`);

  if (section === 'database') {
    if ('mode' in values && values.mode !== null && !DB_MODES.includes(values.mode)) {
      errors.mode = `must be one of ${DB_MODES.join(', ')}`;
    }
    if ('port' in values && values.port != null && !Number.isInteger(Number(values.port))) {
      errors.port = 'must be an integer';
    }
    if ('url' in values && values.url != null && typeof values.url !== 'string') {
      errors.url = 'must be a string';
    }
  }

  if (Object.keys(errors).length) {
    const err = new Error(`invalid config for "${section}": ${JSON.stringify(errors)}`);
    err.code = 'invalid_config';
    err.errors = errors;
    throw err;
  }
}

// ── legacy .env migration ────────────────────────────────────────────────────
// Existing installs configured ~/.sigil/.env. Rather than strand them on a clean
// break, import that file into config.json ONCE, then rename it so it's skipped
// thereafter. A power user can later drop a fresh .env to update settings; it's
// re-imported on the next boot. We map the settings whose silent loss would
// actually break a daemon (db, llm, embedding, network, http, managed-session) so
// an existing .env-configured install upgrades losslessly. Pure tuning knobs
// (MEMORY_* thresholds, per-task model overrides) are NOT carried — they fall
// back to the (identical) code defaults; re-set them in the GUI/config if needed.

function parseEnvFile(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function envToPatches(e) {
  const patches = {};

  const db = {};
  if (e.SIGIL_DATABASE_URL || e.DATABASE_URL) {
    db.mode = 'url';
    db.url = e.SIGIL_DATABASE_URL || e.DATABASE_URL;
  } else if (e.SIGIL_DB_HOST || e.SIGIL_DB_NAME || e.SIGIL_DB_PASSWORD) {
    db.mode = 'local';
    if (e.SIGIL_DB_HOST) db.host = e.SIGIL_DB_HOST;
    if (e.SIGIL_DB_PORT) db.port = Number(e.SIGIL_DB_PORT) || 5432;
    if (e.SIGIL_DB_NAME) db.name = e.SIGIL_DB_NAME;
    if (e.SIGIL_DB_USER) db.user = e.SIGIL_DB_USER;
    if (e.SIGIL_DB_PASSWORD) db.password = e.SIGIL_DB_PASSWORD;
  } else if (e.SIGIL_DB_MODE && DB_MODES.includes(e.SIGIL_DB_MODE)) {
    // Bare SIGIL_DB_MODE=embedded (the zero-config escape hatch) with no
    // url/host — without this the daemon would boot with mode=null and throw.
    db.mode = e.SIGIL_DB_MODE;
  }
  if (Object.keys(db).length) patches.database = db;

  if (e.LLM_PROVIDER) {
    const llm = { provider: e.LLM_PROVIDER };
    const key = { anthropic: e.ANTHROPIC_API_KEY, openai: e.OPENAI_API_KEY, openrouter: e.OPENROUTER_API_KEY }[e.LLM_PROVIDER];
    if (key) llm.apiKey = key;
    const model = { openai: e.LLM_OPENAI_MODEL, openrouter: e.LLM_OPENROUTER_MODEL, ollama: e.LLM_OLLAMA_MODEL, 'claude-cli': e.LLM_CLI_MODEL }[e.LLM_PROVIDER];
    if (model) llm.model = model;
    if (e.LLM_PROVIDER === 'ollama' && (e.LLM_OLLAMA_HOST || e.OLLAMA_HOST)) llm.host = e.LLM_OLLAMA_HOST || e.OLLAMA_HOST;
    patches.llm = llm;
  }

  if (e.EMBEDDING_PROVIDER) {
    const emb = { provider: e.EMBEDDING_PROVIDER };
    if (e.EMBEDDING_MODEL) emb.model = e.EMBEDDING_MODEL;
    const key = { openai: e.OPENAI_API_KEY, voyage: e.VOYAGE_API_KEY, openrouter: e.OPENROUTER_API_KEY }[e.EMBEDDING_PROVIDER];
    if (key) emb.apiKey = key;
    if (e.EMBEDDING_PROVIDER === 'ollama' && e.OLLAMA_HOST) emb.host = e.OLLAMA_HOST;
    patches.embedding = emb;
  }

  // Managed-session engine (opt-in power feature). Carry the toggle so an
  // .env-enabled warm pool doesn't silently fall back to one-shot on upgrade.
  if (e.SIGIL_MANAGED_SESSION !== undefined) {
    patches.llm = patches.llm || {};
    patches.llm.managedSession = { enabled: e.SIGIL_MANAGED_SESSION === 'true' };
  }

  // Network (multi-device). Without this a .env-configured follower/master
  // silently reverts to solo — Iroh never starts and sync stops dead.
  const net = {};
  if (e.SIGIL_MODE) net.mode = e.SIGIL_MODE;
  if (e.SIGIL_NETWORK_ENABLED !== undefined) net.enabled = e.SIGIL_NETWORK_ENABLED !== 'false';
  else if (e.SIGIL_MODE && e.SIGIL_MODE !== 'solo') net.enabled = true; // legacy derive-from-mode
  if (e.SIGIL_MASTER_NODE_ID) net.masterNodeId = e.SIGIL_MASTER_NODE_ID;
  if (Object.keys(net).length) patches.network = net;

  // HTTP server (custom port/host/disabled) — a bookmarked GUI URL / reverse
  // proxy on a non-default port would otherwise break after upgrade.
  const http = {};
  if (e.SIGIL_HTTP_PORT) http.port = Number(e.SIGIL_HTTP_PORT) || 7777;
  if (e.SIGIL_HTTP_HOST) http.host = e.SIGIL_HTTP_HOST;
  if (e.SIGIL_HTTP_ENABLED !== undefined) http.enabled = e.SIGIL_HTTP_ENABLED !== 'false';
  if (Object.keys(http).length) patches.http = http;

  if (e.SIGIL_SETUP_COMPLETE === 'true') patches.setup = { complete: true };
  return patches;
}

let migrationChecked = false;
function migrateEnvIfPresent() {
  if (migrationChecked) return;
  migrationChecked = true;
  try {
    const e = parseEnvFile(SIGIL_ENV_PATH);
    if (!e) return;
    const patches = envToPatches(e);
    // Import a section from .env ONLY if config.json hasn't configured it yet —
    // never clobber values the new wizard already wrote (a leftover .env can be
    // stale, e.g. an old DB password/url). All-or-nothing per section: a half-
    // merged DB (e.g. local fields + a stale url) would be worse than either.
    const existing = pruneUnknown(readRaw());
    const alreadySet = {
      database: Boolean(existing.database?.mode),
      llm: Boolean(existing.llm?.provider),
      embedding: Boolean(existing.embedding?.provider),
      setup: Boolean(existing.setup?.complete),
    };
    for (const [section, values] of Object.entries(patches)) {
      if (alreadySet[section]) continue; // configured already → leave it alone
      try { patchConfig(section, values); } catch { /* skip a bad section, keep going */ }
    }
    // Processed once — rename so it's skipped from now on ("later we skip env").
    try { renameSync(SIGIL_ENV_PATH, `${SIGIL_ENV_PATH}.migrated`); } catch { /* ignore */ }
  } catch { /* best-effort; never block config load on migration */ }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Load (migrate legacy .env → read → migrate schema → prune → merge defaults).
 *
 * `migrateEnv: false` skips the one-time ~/.sigil/.env → config.json import +
 * rename. knexfile.js uses this: importing it for a connection string must not
 * consume the user's .env as a module-load side effect (a failed `npm run
 * migrate` would otherwise have already renamed it). The daemon/CLI run the full
 * migration on their own first load.
 */
export function loadConfig({ migrateEnv = true } = {}) {
  if (migrateEnv) migrateEnvIfPresent();
  let raw = readRaw();
  const migrated = runMigrations(raw);
  // Persist a migration only if it actually changed the version on disk.
  if (existsSync(SIGIL_CONFIG_PATH) && migrated.schemaVersion !== raw.schemaVersion) {
    atomicWrite(pruneUnknown(migrated));
  }
  cache = deepMerge(defaults(), pruneUnknown(migrated));
  resetStaleActiveSteps();
  return cache;
}

// A step is marked 'active' before its apply() runs and 'done'/'error' after.
// If the daemon is hard-killed (crash, reboot, SIGKILL) mid-step, that 'active'
// status is frozen on disk — the GUI then shows a step spinning forever with no
// way to retry. On every load, demote any leftover 'active' back to 'pending'
// so the step is re-runnable. Safe because nothing is genuinely mid-apply at
// load time (the process that owned it is gone).
function resetStaleActiveSteps() {
  const steps = cache?.setup?.steps;
  if (!steps) return;
  const stale = Object.entries(steps).filter(([, s]) => s === 'active').map(([k]) => k);
  if (!stale.length) return;
  const sparse = pruneUnknown(readRaw());
  const next = { ...(sparse.setup?.steps || {}) };
  for (const k of stale) next[k] = 'pending';
  atomicWrite({ ...sparse, schemaVersion: CONFIG_SCHEMA_VERSION, setup: { ...(sparse.setup || {}), steps: next } });
  cache = deepMerge(defaults(), pruneUnknown(readRaw()));
}

/** The current merged snapshot (loads on first access). */
export function getConfig() {
  return cache || loadConfig();
}

// ── test seam ────────────────────────────────────────────────────────────────
// config.json is the sole source of truth (no env override), so tests can no
// longer configure the daemon/embedder/LLM by setting process.env. They seed the
// in-memory cache instead. `__setTestConfig` overlays a partial onto the CURRENT
// cache (or code defaults on first call) — never the developer's real config.json
// on disk, so it stays hermetic AND additive across calls. It also avoids
// triggering loadConfig()'s one-time .env migration on a dev machine.
// `__resetTestConfig` clears it. Test-only — prod never calls these.
export function __setTestConfig(partial = {}) {
  cache = deepMerge(cache ?? defaults(), partial);
  return cache;
}
export function __resetTestConfig() {
  cache = null;
}

/**
 * Merge `values` into one section, validate, persist atomically, refresh cache.
 * Only the provided keys are written (the file stays sparse). Returns the new
 * merged snapshot.
 */
export function patchConfig(section, values) {
  if (!(section in defaults())) throw new Error(`unknown config section: ${section}`);
  validateSection(section, values);
  const sparse = pruneUnknown(readRaw());
  sparse.schemaVersion = CONFIG_SCHEMA_VERSION;
  sparse[section] = { ...(sparse[section] || {}), ...values };
  atomicWrite(sparse);
  cache = deepMerge(defaults(), sparse);
  return cache;
}

/** Return the device id, generating + persisting one on first call. */
export function ensureDeviceId() {
  const cur = getConfig();
  if (cur.device?.id) return cur.device.id;
  const id = randomUUID();
  patchConfig('device', { id });
  return id;
}

/** Record a setup step's status (pending|active|done|error). */
export function setStepStatus(step, status) {
  if (!STEP_STATUSES.includes(status)) throw new Error(`invalid step status: ${status}`);
  const sparse = pruneUnknown(readRaw());
  const steps = { ...(sparse.setup?.steps || {}), [step]: status };
  return patchConfig('setup', { ...(sparse.setup || {}), steps });
}

export function markSetupComplete(complete = true) {
  return patchConfig('setup', { complete: Boolean(complete) });
}

export function isSetupComplete() {
  return Boolean(getConfig().setup?.complete);
}

/** Wipe config back to a fresh, unconfigured state (clean-break re-onboard). */
export function resetConfig() {
  try { if (existsSync(SIGIL_CONFIG_PATH)) unlinkSync(SIGIL_CONFIG_PATH); } catch { /* ignore */ }
  cache = null;
  return getConfig();
}

/** The build-time embedding dimension, surfaced here for convenience. */
export { EMBEDDING_DIM };
