/**
 * Setup step: LLM provider.
 *
 * Writes the chosen provider (+ key/model/host) to config.json, then runs a
 * live one-word completion to prove it works. Errors surface the RAW provider
 * message — we deliberately do NOT route them through diagnoseError(), whose
 * regexes target embedding/DB failures and would mislabel an LLM "unknown
 * model" error as an embedding-model error.
 */
import { patchConfig } from '../config-store.js';
import { StepError } from '../errors.js';

// id, label, hint, recommended, and the fields to collect. Keys map to the
// config.json `llm` section ({ provider, model, apiKey, host }).
const PROVIDERS = [
  {
    id: 'ollama', label: 'Ollama', hint: 'Local and private; requires a running Ollama server', recommended: true,
    fields: [
      { name: 'host', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434', optional: true },
      { name: 'model', label: 'Model', type: 'text', placeholder: 'qwen2.5:7b' },
    ],
  },
  {
    id: 'openrouter', label: 'OpenRouter', hint: 'One key, many models (cheapest default)',
    fields: [
      { name: 'apiKey', label: 'OpenRouter API key', type: 'password', placeholder: 'sk-or-…' },
      { name: 'model', label: 'Model', type: 'text', placeholder: 'google/gemini-flash-latest' },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', hint: 'Direct OpenAI access',
    fields: [
      { name: 'apiKey', label: 'OpenAI API key', type: 'password', placeholder: 'sk-…' },
      { name: 'model', label: 'Model', type: 'text', placeholder: 'gpt-4o-mini' },
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic', hint: 'Direct Anthropic API access',
    fields: [{ name: 'apiKey', label: 'Anthropic API key', type: 'password', placeholder: 'sk-ant-…' }],
  },
  { id: 'claude-cli', label: 'Claude Code', hint: 'Manual generation only; automatic hooks will not spawn coding-agent sessions by default', fields: [] },
];

const KEYED = new Set(['openrouter', 'openai', 'anthropic']);
// Providers that expose a model field — a model is required for these (the GUI
// shows an OpenRouter model picker; the others are typed).
const NEEDS_MODEL = new Set(['openrouter', 'openai', 'ollama']);

export const id = 'llm';
export const title = 'LLM provider';

export function listProviders() { return PROVIDERS; }
export function detect() { return { providers: listProviders() }; }

export function validate(input = {}) {
  const errors = {};
  const p = PROVIDERS.find((x) => x.id === input.provider);
  if (!p) { errors.provider = 'choose a provider'; return { ok: false, errors }; }
  if (KEYED.has(p.id) && !input.apiKey) errors.apiKey = 'an API key is required';
  if (NEEDS_MODEL.has(p.id) && !input.model) errors.model = 'a model is required';
  return { ok: Object.keys(errors).length === 0, errors };
}

export async function apply(input, emit = () => {}) {
  const p = PROVIDERS.find((x) => x.id === input.provider);
  if (!p) throw new StepError({ message: `Unknown LLM provider: ${input.provider}`, kind: 'other' });

  emit({ pct: 20, label: 'Saving provider…' });
  patchConfig('llm', {
    provider: p.id,
    model: input.model || null,
    apiKey: input.apiKey || null,
    host: input.host || null,
  });

  emit({ pct: 55, label: 'Testing live LLM call…' });
  try {
    const { resetDetection } = await import('../../lib/llm/registry.js');
    resetDetection(); // pick up the just-saved config, not the boot-time provider
    const { prompt } = await import('../../lib/llm.js');
    const out = await prompt('Reply with the single word: ok', { caller: 'setup-llm-test' });
    emit({ pct: 100, label: 'LLM ready.' });
    return { provider: p.id, response: String(out).slice(0, 200) };
  } catch (err) {
    // RAW message on purpose (see file header).
    throw new StepError({ message: err.message, kind: 'llm' });
  }
}

export default { id, title, detect, listProviders, validate, apply };
