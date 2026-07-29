/**
 * Setup service — orchestrates the native first-run steps.
 *
 * Responsibilities (and ONLY these — each step owns its own logic/validation/
 * errors):
 *   - hold the ordered setup list (DB → Embed, then optional integrations)
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
 * Generation is deliberately outside the required path. A user can store and
 * retrieve memory with only a database and embedder; an LLM provider enables
 * opt-in enrichment features but must never hold onboarding or health hostage.
 */
import bus from '../daemon/events.js';
import { getConfig, patchConfig, setStepStatus, markSetupComplete, EMBEDDING_DIM } from './config-store.js';
import databaseStep from './steps/database.js';
import llmStep from './steps/llm.js';
import embeddingStep from './steps/embedding.js';
import connectorsStep from './steps/connectors.js';

// Only storage and semantic search are prerequisites for a usable local memory
// system. Agent wiring and generation add capabilities, but neither should keep
// a user from a ready CLI/MCP install.
const STEPS = [databaseStep, embeddingStep, connectorsStep, llmStep];

// The full intended order for display, so the GUI can show upcoming steps even
// before they're implemented. Steps not in STEPS are shown but not runnable.
const PLANNED = [
  { id: 'database', title: 'Database', required: true },
  { id: 'embedding', title: 'Embeddings', required: true },
  { id: 'connectors', title: 'Coding agents', required: false },
  { id: 'llm', title: 'LLM provider', required: false },
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

/**
 * Pure state derivation kept separate from config IO so completion semantics
 * are easy to regression-test. Optional steps remain visible to Settings but
 * are excluded from both the onboarding cursor and completion gate.
 */
export function deriveSetupState(cfg) {
  const steps = PLANNED.map((p) => ({
    ...p,
    implemented: STEPS.some((s) => s.id === p.id),
    status: cfg.setup?.steps?.[p.id] || 'pending',
  }));
  const required = steps.filter((s) => s.required);
  const next = required.find((s) => s.implemented && s.status !== 'done')?.id || null;
  const complete = required.length > 0 && required.every((s) => s.status === 'done');
  return { complete, steps, currentStep: next };
}

/** Current setup state: per-step status (from config.json) + the next step. */
export function getSetupState() {
  return deriveSetupState(getConfig());
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

    // Persist the derived core completion flag for external/legacy readers.
    // Optional enrichment steps never reopen an otherwise working setup.
    const state = getSetupState();
    if (getConfig().setup?.complete !== state.complete) {
      markSetupComplete(state.complete);
    }

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
    setup: c.setup,
  };
}

/**
 * Generation is optional. Turning it off removes the configured provider and
 * credential while preserving storage, embeddings, and every stored memory.
 */
export async function disableLlm() {
  patchConfig('llm', { provider: null, model: null, apiKey: null, host: null });
  setStepStatus('llm', 'pending');
  try {
    const { resetDetection } = await import('../lib/llm/registry.js');
    resetDetection();
  } catch { /* the config change is still valid if the optional registry is unavailable */ }
  return { disabled: true, config: getSetupConfig() };
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
