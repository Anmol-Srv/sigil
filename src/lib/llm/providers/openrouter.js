/**
 * OpenRouter provider.
 *
 * OpenRouter is an OpenAI-compatible API gateway in front of many model
 * vendors (Anthropic, OpenAI, Meta, Mistral, Google, ...). One key, one
 * base URL, many models — model names are namespaced like
 * "anthropic/claude-sonnet-4-5" or "openai/gpt-4o".
 *
 * This provider reuses the OpenAI chat-completions response shape; only
 * the base URL, auth, and optional analytics headers (HTTP-Referer +
 * X-Title) differ.
 *
 * Docs: https://openrouter.ai/docs
 */

import config from '../../../config.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

async function chat(input, { model, jsonMode = false } = {}) {
  const resolved = model || config.llm.openrouterModel;
  if (!config.llm.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!resolved) {
    throw new Error('No OpenRouter model resolved. Set LLM_OPENROUTER_MODEL or pass `model`.');
  }

  const messages = [{ role: 'user', content: input }];
  if (jsonMode && !input.toLowerCase().includes('json')) {
    messages.unshift({ role: 'system', content: 'Respond with valid JSON.' });
  }

  const body = { model: resolved, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const baseUrl = (config.llm.openrouterBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.llm.openrouterApiKey}`,
  };
  // OpenRouter uses HTTP-Referer + X-Title for app attribution in their
  // analytics dashboard. Optional but they ask nicely.
  if (config.llm.openrouterReferer) headers['HTTP-Referer'] = config.llm.openrouterReferer;
  if (config.llm.openrouterTitle) headers['X-Title'] = config.llm.openrouterTitle;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  const data = await response.json();
  // OpenRouter returns the OpenAI shape, but some upstream providers omit
  // usage. Guard against missing fields.
  const choice = data.choices?.[0];
  const text = (choice?.message?.content || '').trim();
  const usage = data.usage || {};

  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    model: data.model || resolved,
  };
}

// ─── Init metadata + setup ──────────────────────────────────────────────────
// OpenRouter setup is the gnarliest of the 5: key + default model + an
// optional "smart split" sub-flow that overrides extraction / decision /
// synthesis models individually. Keeping it in this file means the whole
// provider surface lives in one place.
const meta = {
  id: 'openrouter',
  label: 'OpenRouter',
  hint: 'one key, many models (Anthropic / OpenAI / Meta / ...)',
};

const DEFAULT_MODEL = 'google/gemini-flash-latest';
const SMART_SPLIT_DEFAULTS = {
  extraction: 'openrouter:qwen/qwen3.5-flash',
  decision:   'openrouter:anthropic/claude-sonnet-latest',
  synthesis:  'openrouter:anthropic/claude-sonnet-latest',
};

async function setup({ existing, clack }) {
  const env = {};

  // ── Key ────────────────────────────────────────────────────────────
  const currentKey = existing.OPENROUTER_API_KEY || '';
  const key = await clack.text({
    message: 'OpenRouter API key (paste, then Enter)',
    placeholder: currentKey ? '(keep existing — press Enter)' : 'sk-or-v1-...',
    validate: (v) => {
      if (!v && !currentKey) return 'API key is required';
      if (v && !v.startsWith('sk-or-')) return 'OpenRouter keys start with "sk-or-" — check paste';
    },
  });
  if (clack.isCancel(key)) return null;
  env.OPENROUTER_API_KEY = key || currentKey;

  // ── Default model ──────────────────────────────────────────────────
  // Gemini Flash latest is the best singular all-rounder at current
  // OpenRouter pricing ($0.0005/$0.003 per 1M; 1M context; strong JSON;
  // ~500ms latency). Beats Claude Haiku 2× on cost while matching JSON
  // + reasoning across all of Sigil's call types.
  const currentModel = existing.LLM_OPENROUTER_MODEL || '';
  const model = await clack.text({
    message: 'OpenRouter model (vendor/model)',
    placeholder: currentModel || DEFAULT_MODEL,
    validate: (v) => {
      if (v && !v.includes('/')) return 'OpenRouter models are "vendor/model" — e.g. google/gemini-flash-latest';
    },
  });
  if (clack.isCancel(model)) return null;
  env.LLM_OPENROUTER_MODEL = model || currentModel || DEFAULT_MODEL;

  // ── Smart split (opt-in) ───────────────────────────────────────────
  // ~5× cheaper extraction (high volume) + best-in-class reasoning for
  // AUDM / synthesis (low volume) at the cost of debugging three model
  // behaviors. Most users want the singular pick.
  const wantsAdvanced = await clack.select({
    message: 'Configure per-task model overrides? (advanced — better quality / cost)',
    options: [
      { value: 'no',  label: 'No, use one model everywhere', hint: 'simpler — debug one model' },
      { value: 'yes', label: 'Yes, configure smart split',   hint: '~5× cheaper extraction + better AUDM/synthesis' },
    ],
    initialValue: 'no',
  });
  if (clack.isCancel(wantsAdvanced)) return null;

  if (wantsAdvanced === 'yes') {
    const ext = await clack.text({
      message: 'Extraction model (high-volume; cheap matters)',
      placeholder: existing.LLM_EXTRACTION_MODEL || SMART_SPLIT_DEFAULTS.extraction,
    });
    if (clack.isCancel(ext)) return null;
    env.LLM_EXTRACTION_MODEL = ext || existing.LLM_EXTRACTION_MODEL || SMART_SPLIT_DEFAULTS.extraction;

    const dec = await clack.text({
      message: 'Decision model (AUDM; smart matters)',
      placeholder: existing.LLM_DECISION_MODEL || SMART_SPLIT_DEFAULTS.decision,
    });
    if (clack.isCancel(dec)) return null;
    env.LLM_DECISION_MODEL = dec || existing.LLM_DECISION_MODEL || SMART_SPLIT_DEFAULTS.decision;

    const syn = await clack.text({
      message: 'Synthesis model (read-time answer composition)',
      placeholder: existing.SIGIL_SYNTH_MODEL || SMART_SPLIT_DEFAULTS.synthesis,
    });
    if (clack.isCancel(syn)) return null;
    env.SIGIL_SYNTH_MODEL = syn || existing.SIGIL_SYNTH_MODEL || SMART_SPLIT_DEFAULTS.synthesis;
  }

  clack.note(
    'OpenRouter can drive both LLM calls and embeddings.\n'
    + 'You will pick an embedding provider in the next step — "openrouter" is an option,\n'
    + 'or you can use a direct provider (Ollama / OpenAI / Voyage) for embeddings.',
    'OpenRouter scope',
  );

  return { env };
}

export { chat, meta, setup };
