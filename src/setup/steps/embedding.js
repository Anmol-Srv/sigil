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
  listCompatibleModels, isReachable, pullModel,
  RECOMMENDED_EMBED_MODEL, OLLAMA_EMBED_MODELS,
} from '../../lib/llm/ollama-admin.js';

// Cloud providers are PINNED to one model (their only 1024-dim option here).
// Ollama is different: `model` is the DEFAULT, but the user may pick any
// compatible 1024-dim model from detect().ollama.models, and apply() pulls it
// if it isn't installed yet. `shared` means the key can be reused from the LLM
// step when that step picked the same provider.
const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', hint: 'text-embedding-3-large @ 1024 — best out-of-the-box quality', recommended: true, model: 'text-embedding-3-large', keyed: true, shared: true },
  { id: 'voyage', label: 'Voyage', hint: 'voyage-3 @ 1024', model: 'voyage-3', keyed: true, shared: false },
  { id: 'openrouter', label: 'OpenRouter', hint: 'Gateway; reuses your LLM key', model: 'openai/text-embedding-3-large', keyed: true, shared: true },
  { id: 'ollama', label: 'Ollama (local)', hint: '1024-dim local embeddings, free — pick a model, auto-pulled if missing', model: RECOMMENDED_EMBED_MODEL, keyed: false, shared: false },
];

export const id = 'embedding';
export const title = 'Embeddings';

// Resolve the Ollama host the embedder will actually use.
function ollamaHost() {
  const cfg = getConfig();
  return process.env.OLLAMA_HOST || cfg.embedding?.host || 'http://localhost:11434';
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
  return {
    providers: listProviders(),
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

  // Resolve the model. Cloud providers are pinned. For Ollama the user may pick
  // any compatible model; validate the choice against the curated 1024-dim list
  // so a free-text mistake can't slip a wrong-dimension model through.
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

  // Ollama: make sure the chosen model is actually present locally, pulling it
  // (with streamed progress) if not. This is what closes the "GUI errored
  // because the model wasn't pulled" gap — setup now provisions it.
  if (p.id === 'ollama') {
    const host = ollamaHost();
    if (!(await isReachable(host))) {
      throw new StepError({
        message: 'The local Ollama server is not reachable.',
        hint: 'Start it with `ollama serve`, then retry.',
        kind: 'ollama-down',
      });
    }
    const installed = (await listCompatibleModels(host)).find((m) => m.name === model)?.installed;
    if (!installed) {
      emit({ pct: 30, label: `Pulling ${model}…` });
      try {
        await pullModel(model, ({ status, percent }) => {
          // Map the pull into the 30–50% band of this step's progress bar.
          const pct = percent == null ? 35 : 30 + Math.round(percent * 0.2);
          emit({ pct, label: `Pulling ${model}: ${status}${percent == null ? '' : ` ${percent}%`}` });
        }, host);
      } catch (err) {
        throw new StepError({
          message: `Failed to pull ${model} from Ollama: ${err.message}`,
          hint: `Pull it manually with \`ollama pull ${model}\`, then retry.`,
          kind: 'model-not-found',
        });
      }
    }
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
    return { provider: p.id, model: p.model, dim: v.length, staleFacts: staleNote ? true : false };
  } catch (err) {
    if (err instanceof StepError) throw err;
    // Classify provider/key/model failures honestly.
    const { fromError } = await import('../db/shared.js');
    throw fromError(err);
  }
}

export default { id, title, detect, listProviders, validate, apply };
