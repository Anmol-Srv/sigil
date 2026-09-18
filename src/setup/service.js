/**
 * Setup service — orchestrates the native first-run steps.
 *
 * Responsibilities (and ONLY these — each step owns its own logic/validation/
 * errors):
 *   - hold the ordered step list (DB → LLM → Embed → Name)
 *   - expose state derived from config.json's setup.steps
 *   - run a step: validate → mark active → apply (streaming progress) → mark
 *     done/error, persisting status to config.json so the flow resumes
 *   - emit { type:'setup', … } on the event bus; the GUI's WebSocket fans these
 *     out as a live stepped progress bar (no terminal-style logs)
 *
 * Progress event shape on the bus:
 *   { type:'setup', step, status:'active'|'done'|'error'|'reset', pct, label,
 *     hint?, kind?, errors?, result? }
 *
 * NOTE: only the `database` step is registered today. LLM/Embed/Name land once
 * config.js reads from the config store (they need runtime config + the DB
 * pool). The service + GUI render whatever steps are registered, so adding them
 * later requires no orchestration changes.
 */
import bus from '../daemon/events.js';
import { getConfig, setStepStatus, markSetupComplete, resetConfig, EMBEDDING_DIM } from './config-store.js';
import databaseStep from './steps/database.js';
import llmStep from './steps/llm.js';
import embeddingStep from './steps/embedding.js';
import connectorsStep from './steps/connectors.js';
import identityStep from './steps/identity.js';

// Ordered: DB → LLM → Embeddings → Coding agents → Your name.
const STEPS = [databaseStep, llmStep, embeddingStep, connectorsStep, identityStep];

// The full intended order for display, so the GUI can show upcoming steps even
// before they're implemented. Steps not in STEPS are shown but not runnable.
const PLANNED = [
  { id: 'database', title: 'Database' },
  { id: 'llm', title: 'LLM provider' },
  { id: 'embedding', title: 'Embeddings' },
  { id: 'connectors', title: 'Coding agents' },
  { id: 'identity', title: 'Your name' },
];

// Mask credentials in a step result before it crosses the bus / RPC boundary.
// The DB step returns a Postgres connection url with the plaintext password;
// the bus replays buffered events to GUI WebSocket clients, so the raw url must
// never leave this function. Recurses so a nested url is caught too.
function redactSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && /url|uri|dsn|conn/i.test(k)) {
      // scheme://user:password@host → scheme://user:***@host
      out[k] = v.replace(/(\w+:\/\/[^:@/\s]+):[^@/\s]+@/g, '$1:***@');
    } else if (v && typeof v === 'object') {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function findStep(id) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) {
    const e = new Error(`setup step not available: ${id}`);
    e.code = 'invalid_params';
    throw e;
  }
  return step;
}

/** The planned step list (id + title + whether it's runnable yet). */
export function listSteps() {
  const runnable = new Set(STEPS.map((s) => s.id));
  return PLANNED.map((p) => ({ ...p, implemented: runnable.has(p.id) }));
}

/** Current setup state: per-step status (from config.json) + the next step. */
export function getSetupState() {
  const cfg = getConfig();
  const steps = PLANNED.map((p) => ({
    ...p,
    implemented: STEPS.some((s) => s.id === p.id),
    status: cfg.setup?.steps?.[p.id] || 'pending',
  }));
  const next = steps.find((s) => s.implemented && s.status !== 'done')?.id || null;
  // Derive completion from the steps so adding a new step (e.g. connectors)
  // automatically reopens setup until it's done — never trust a stale persisted
  // flag. (markSetupComplete is still written for any external readers.)
  const complete = steps.length > 0 && steps.every((s) => s.status === 'done');
  return { complete, steps, currentStep: next };
}

/** Run a step's detection (drives the UI's choices). {} when it has none. */
export async function detectStep(id) {
  const step = findStep(id);
  return typeof step.detect === 'function' ? step.detect() : {};
}

/**
 * Validate → apply → persist status, streaming progress on the bus.
 * Returns { ok, step, result?|error?, hint?, kind?, errors?, state }.
 */
export async function runStep(id, input = {}) {
  const step = findStep(id);

  const v = step.validate ? step.validate(input) : { ok: true };
  if (!v.ok) {
    bus.emit('setup', { step: id, status: 'error', pct: 0, label: 'Please fix the highlighted fields.', errors: v.errors });
    return { ok: false, step: id, errors: v.errors, state: getSetupState() };
  }

  setStepStatus(id, 'active');
  bus.emit('setup', { step: id, status: 'active', pct: 0, label: `Starting ${step.title}…` });
  const emit = (p = {}) => bus.emit('setup', { step: id, status: 'active', pct: p.pct ?? 0, label: p.label || '' });

  try {
    const result = await step.apply(input, emit);
    setStepStatus(id, 'done');
    // The DB step returns a connection url with the plaintext password. The bus
    // buffers and replays every event to GUI WebSocket subscribers, so emitting
    // (or returning) the raw result would leak the password. Redact first.
    const safeResult = redactSecrets(result);
    bus.emit('setup', { step: id, status: 'done', pct: 100, label: `${step.title} ready.`, result: safeResult });

    // Mark the whole setup complete only when every PLANNED step is done.
    const state = getSetupState();
    const allDone = state.steps.every((s) => s.status === 'done');
    if (allDone && !state.complete) markSetupComplete(true);

    return { ok: true, step: id, result: safeResult, state: getSetupState() };
  } catch (err) {
    setStepStatus(id, 'error');
    bus.emit('setup', { step: id, status: 'error', pct: 0, label: err.message, hint: err.hint || null, kind: err.kind || 'other' });
    return { ok: false, step: id, error: err.message, hint: err.hint || null, kind: err.kind || 'other', state: getSetupState() };
  }
}

/**
 * Safe config summary for the Settings page (secrets reported as booleans, the
 * DB url reduced to its host). Replaces the legacy onboardingState env summary.
 */
export function getSetupConfig() {
  const c = getConfig();
  let urlHost = null;
  if (c.database.url) { try { urlHost = new URL(c.database.url).host; } catch { urlHost = '(connection url)'; } }
  return {
    database: { mode: c.database.mode, host: c.database.host, port: c.database.port, name: c.database.name, urlHost },
    llm: { provider: c.llm.provider, model: c.llm.model, hasKey: Boolean(c.llm.apiKey) },
    embedding: { provider: c.embedding.provider, model: c.embedding.model, dim: EMBEDDING_DIM, hasKey: Boolean(c.embedding.apiKey) },
    jev: { enabled: c.jev.enabled === true, model: c.jev.model, hasKey: Boolean(c.jev.apiKey) },
    identity: { name: c.identity.name },
    setup: c.setup,
  };
}

/** Clean-break reset — wipe config and start setup over. */
export function resetSetup() {
  resetConfig();
  bus.emit('setup', { step: null, status: 'reset', pct: 0, label: 'Setup reset.' });
  return getSetupState();
}

/**
 * In-app factory reset (GUI): disconnect all agents, optionally wipe stored
 * memory, and wipe config. Returns a summary + the fresh setup state.
 */
export async function factoryResetSetup({ wipeMemory = true } = {}) {
  const { factoryReset } = await import('./reset.js');
  const result = await factoryReset({ wipeMemory });
  bus.emit('setup', { step: null, status: 'reset', pct: 0, label: 'Sigil reset.' });
  return { ...result, state: getSetupState() };
}
