/**
 * Setup step: Embeddings.
 *
 * Every provider is PINNED to a model that produces Sigil's fixed dimension
 * (EMBEDDING_DIM = 1024) — no free-text model field, so the "model not
 * supported" / dimension-mismatch failure class can't happen. apply() writes
 * the provider + pinned model + key, then runs a cache-bypassed embed and
 * asserts the vector length is exactly 1024.
 */
import { patchConfig, getConfig } from '../config-store.js';
import { StepError } from '../errors.js';
import { EMBEDDING_DIM } from '../../lib/constants.js';
import {
  listCompatibleModels, isReachable,
  RECOMMENDED_EMBED_MODEL, OLLAMA_EMBED_MODELS,
} from '../../lib/llm/ollama-admin.js';

// Cloud providers are PINNED to one model (their only 1024-dim option here).
// Ollama is different: Sigil uses a compatible model the user has already
// installed. Setup never starts a runtime or downloads a large model behind the
// user's back. `shared` means the key can be reused from the LLM step when that
// step picked the same provider.
const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', hint: 'text-embedding-3-large @ 1024 — best out-of-the-box quality', recommended: true, model: 'text-embedding-3-large', keyed: true, shared: true },
  { id: 'voyage', label: 'Voyage', hint: 'voyage-3 @ 1024', model: 'voyage-3', keyed: true, shared: false },
  { id: 'openrouter', label: 'OpenRouter', hint: 'Gateway; reuses your LLM key', model: 'openai/text-embedding-3-large', keyed: true, shared: true },
  { id: 'ollama', label: 'Ollama (already running)', hint: 'Use a compatible local embedding model you already run', model: RECOMMENDED_EMBED_MODEL, keyed: false, shared: false },
];

export const id = 'embedding';
export const title = 'Embeddings';

// Resolve the Ollama host the embedder will actually use. config.json is the
// source of truth (no env override) — mirrors config.embedding.ollamaHost.
function ollamaHost() {
  const cfg = getConfig();
  return cfg.embedding?.host || 'http://localhost:11434';
}

export function listProviders() {
  // Tell the UI whether a shared key already exists so it can hide the field.
  const cfg = getConfig();
  return PROVIDERS.map((p) => ({
    ...p,
    sharedKeyAvailable: p.shared && cfg.llm.provider === p.id && Boolean(cfg.llm.apiKey),
  }));
}

export async function detect() {
  // Enrich the response with the Ollama model picker data so the GUI/CLI can
  // render a dropdown: which compatible 1024-dim models exist and which are
  // already pulled. Best-effort — a missing/stopped Ollama just reports
  // reachable:false with the full candidate list (all installed:false).
  const host = ollamaHost();
  const reachable = await isReachable(host);
  const models = await listCompatibleModels(host);
  const installed = models.filter((model) => model.installed);
  const localAvailable = reachable && installed.length > 0;
  return {
    providers: listProviders().map((provider) => {
      if (provider.id !== 'ollama') return { ...provider, recommended: localAvailable ? false : provider.recommended };
      return {
        ...provider,
        recommended: localAvailable,
        available: localAvailable,
        hint: localAvailable
          ? `Local — ${installed.map((model) => model.name).join(', ')} detected`
          : reachable
            ? 'No compatible local embedding model detected'
            : 'Not running on this machine',
      };
    }),
    ollama: { reachable, host, models, recommended: RECOMMENDED_EMBED_MODEL },
  };
}

/** The key to use: explicit input, else the LLM step's key if same provider. */
function resolveKey(p, input) {
  if (input.apiKey) return input.apiKey;
  if (p.shared) {
    const cfg = getConfig();
    if (cfg.llm.provider === p.id && cfg.llm.apiKey) return cfg.llm.apiKey;
  }
  return null;
}

export function validate(input = {}) {
  const errors = {};
  const p = PROVIDERS.find((x) => x.id === input.provider);
  if (!p) errors.provider = 'choose a provider';
  else if (p.keyed && !resolveKey(p, input)) errors.apiKey = 'an API key is required';
  return { ok: Object.keys(errors).length === 0, errors };
}

export async function apply(input, emit = () => {}) {
  const p = PROVIDERS.find((x) => x.id === input.provider);
  if (!p) throw new StepError({ message: `Unknown embedding provider: ${input.provider}`, kind: 'other' });

  // Resolve the model. Cloud providers are pinned. For Ollama accept a curated
  // 1024-dim model and prefer one that is already installed locally.
  let model = p.model;
  if (p.id === 'ollama' && input.model) {
    const allowed = OLLAMA_EMBED_MODELS.map((m) => m.name);
    if (!allowed.includes(input.model)) {
      throw new StepError({
        message: `"${input.model}" isn't a known 1024-dim Ollama embedding model.`,
        hint: `Choose one of: ${allowed.join(', ')}.`,
        kind: 'model-not-found',
      });
    }
    model = input.model;
  }

  emit({ pct: 20, label: 'Saving provider…' });
  patchConfig('embedding', {
    provider: p.id,
    model,
    apiKey: resolveKey(p, input),
    host: input.host || null,
  });

  // Ollama is opt-in only when it is ready. Running or downloading third-party
  // software/models inside a memory installer makes resource use surprising,
  // especially on VMs, so provide an honest recovery action instead.
  if (p.id === 'ollama') {
    const host = ollamaHost();
    if (!(await isReachable(host))) {
      throw new StepError({
        message: 'The local Ollama server is not reachable.',
        hint: 'Start your existing Ollama service, or choose an API-key provider instead.',
        kind: 'ollama-down',
      });
    }
    const candidates = await listCompatibleModels(host);
    const selected = candidates.find((candidate) => candidate.name === model && candidate.installed)
      || candidates.find((candidate) => candidate.installed);
    if (!selected) {
      throw new StepError({
        message: 'No compatible local embedding model is installed in Ollama.',
        hint: `Install one of: ${OLLAMA_EMBED_MODELS.map((candidate) => candidate.name).join(', ')}; then retry, or choose an API-key provider.`,
        kind: 'model-not-found',
      });
    }
    model = selected.name;
  }

  emit({ pct: 55, label: 'Testing embed call…' });
  try {
    const { resetDetection } = await import('../../lib/llm/registry.js');
    resetDetection();
    const { embed } = await import('../../ingestion/embedder.js');
    // cache:false — don't touch the Postgres embedding cache; this just probes
    // the provider. Verify the model emits exactly our fixed dimension.
    const v = await embed('Sigil setup embedding test', { cache: false });
    if (!Array.isArray(v) || v.length === 0) {
      throw new StepError({ message: 'The embedder returned an empty vector.', kind: 'other' });
    }
    if (v.length !== EMBEDDING_DIM) {
      throw new StepError({
        message: `This model returned ${v.length}-dim vectors, but Sigil requires ${EMBEDDING_DIM}.`,
        hint: `Pick a provider/model that produces ${EMBEDDING_DIM}-dim embeddings.`,
        kind: 'model-not-found',
      });
    }
    // If the corpus already has facts under a different model, switching now
    // leaves them in a foreign vector space — warn and point at the repair.
    let staleNote = '';
    try {
      const { checkCorpusConsistency } = await import('../../memory/facts/embedding-consistency.js');
      const c = await checkCorpusConsistency();
      if (c.stale > 0) staleNote = ` ${c.stale} existing facts use a different model — run \`sigil repair embeddings\` so they rank correctly.`;
    } catch { /* best effort — never fail the step on the advisory check */ }

    emit({ pct: 100, label: `Embedder ready.${staleNote}` });
    return { provider: p.id, model, dim: v.length, staleFacts: staleNote ? true : false };
  } catch (err) {
    if (err instanceof StepError) throw err;
    // Classify provider/key/model failures honestly.
    const { fromError } = await import('../db/shared.js');
    throw fromError(err);
  }
}

export default { id, title, detect, listProviders, validate, apply };
