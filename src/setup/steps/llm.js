/**
 * Setup step: LLM provider.
 *
 * Writes the chosen provider (+ key/model/host) to config.json, then runs a
 * live one-word completion to prove it works. Errors surface the RAW provider
 * message — we deliberately do NOT route them through diagnoseError(), whose
 * regexes target embedding/DB failures and would mislabel an LLM "unknown
 * model" error as an embedding-model error.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { patchConfig } from '../config-store.js';
import { StepError } from '../errors.js';

// id, label, hint, recommended, and the fields to collect. Keys map to the
// config.json `llm` section ({ provider, model, apiKey, host }).
const PROVIDERS = [
  {
    id: 'claude-cli', label: 'Claude Code', hint: 'Uses your existing Claude Code subscription — no API key', recommended: true,
    fields: [{
      name: 'model', label: 'Model', type: 'select', default: 'haiku',
      // The CLI's stable ALIASES, not pinned ids: `claude` resolves an alias to
      // the current version, so this list can't go stale. Passing a pinned id
      // would rot on the next model release.
      options: [
        { value: 'haiku', label: 'Haiku', hint: 'fastest and cheapest, recommended' },
        { value: 'sonnet', label: 'Sonnet', hint: 'better judgement, slower' },
        { value: 'opus', label: 'Opus', hint: 'strongest, slowest, priciest' },
      ],
    }],
  },
  {
    id: 'codex', label: 'Codex CLI', hint: 'Uses your existing Codex subscription — no API key',
    // Codex exposes no way to enumerate models, so there is no honest list to
    // show. It DOES already have a model in ~/.codex/config.toml, so the default
    // is to defer to it (blank => no `-m` flag) rather than invent a second
    // source of truth. detect() fills the placeholder with whatever that is, so
    // the choice is at least visible instead of silent.
    fields: [{ name: 'model', label: 'Model', type: 'text', optional: true, placeholder: 'from your ~/.codex/config.toml' }],
  },
  {
    id: 'openrouter', label: 'OpenRouter', hint: 'One key, many models (cheapest default)',
    fields: [
      { name: 'apiKey', label: 'OpenRouter API key', type: 'password', placeholder: 'sk-or-…' },
      // Free text on purpose: OpenRouter's catalog is thousands of models and
      // changes daily, and listing it needs the key that's being entered on this
      // same form. A stale hardcoded list would be worse than a placeholder.
      { name: 'model', label: 'Model', type: 'text', placeholder: 'google/gemini-flash-latest' },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', hint: 'Direct OpenAI access',
    fields: [
      { name: 'apiKey', label: 'OpenAI API key', type: 'password', placeholder: 'sk-…' },
      {
        name: 'model', label: 'Model', type: 'select', default: 'gpt-4o-mini',
        options: [
          { value: 'gpt-4o-mini', label: 'gpt-4o-mini', hint: 'cheapest, recommended' },
          { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
          { value: 'gpt-4.1-nano', label: 'gpt-4.1-nano' },
          { value: 'gpt-4o', label: 'gpt-4o', hint: 'strongest, priciest' },
        ],
      },
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic', hint: 'Direct Anthropic API access',
    fields: [
      { name: 'apiKey', label: 'Anthropic API key', type: 'password', placeholder: 'sk-ant-…' },
      {
        // Previously absent entirely — picking Anthropic gave you no way to say
        // which model, so it silently used the provider default.
        name: 'model', label: 'Model', type: 'select', default: 'claude-haiku-4-5-20251001',
        options: [
          { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'fastest + cheapest' },
          { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
          { value: 'claude-opus-4-6', label: 'Opus 4.6', hint: 'strongest, priciest' },
        ],
      },
    ],
  },
  {
    id: 'ollama', label: 'Ollama', hint: 'Local + private; slower on small machines',
    fields: [
      { name: 'host', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434', optional: true },
      // Options are filled live by detect() from /api/tags — the models actually
      // installed on this machine, which is the only list that means anything
      // for a local runtime. Falls back to free text when Ollama is unreachable.
      { name: 'model', label: 'Model', type: 'select', options: [], placeholder: 'qwen2.5:7b' },
    ],
  },
];

const KEYED = new Set(['openrouter', 'openai', 'anthropic']);
// Providers that expose a model field — a model is required for these (the GUI
// shows an OpenRouter model picker; the others are typed).
// CLI-subscription providers (claude-cli, codex) are absent here on purpose:
// each CLI carries its own default model, so an explicit choice is optional.
const NEEDS_MODEL = new Set(['openrouter', 'openai', 'ollama']);

export const id = 'llm';
export const title = 'LLM provider';

export function listProviders() { return PROVIDERS; }

/**
 * Enrich the static provider list with what's actually available on THIS
 * machine, so the picker offers real choices instead of guesses:
 *   • Ollama  — the models genuinely installed, via /api/tags. A hardcoded list
 *               is meaningless for a local runtime.
 *   • Codex   — the model already configured in ~/.codex/config.toml, shown as
 *               the placeholder so deferring to it is an informed choice.
 * Never throws and never blocks: a missing Ollama or codex config just leaves
 * the field as free text with its original placeholder.
 */
export async function detect() {
  const providers = PROVIDERS.map((p) => ({ ...p, fields: p.fields.map((f) => ({ ...f })) }));

  const ollama = providers.find((p) => p.id === 'ollama');
  const ollamaModelField = ollama?.fields.find((f) => f.name === 'model');
  if (ollamaModelField) {
    const installed = await listOllamaModels();
    if (installed.length) {
      ollamaModelField.options = installed.map((m) => ({ value: m, label: m }));
      ollamaModelField.default = installed[0];
    } else {
      // Nothing installed (or Ollama down) — a select with no options is a dead
      // end, so degrade to the typed field it used to be.
      ollamaModelField.type = 'text';
      delete ollamaModelField.options;
    }
  }

  const codexModelField = providers.find((p) => p.id === 'codex')?.fields.find((f) => f.name === 'model');
  const configured = readCodexConfiguredModel();
  if (codexModelField && configured) {
    codexModelField.placeholder = `${configured} (from your codex config)`;
  }

  return { providers };
}

/** Models installed in the local Ollama, or [] if it isn't reachable. */
async function listOllamaModels(host = 'http://localhost:11434') {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}

/** The `model = "..."` line from ~/.codex/config.toml, or null. */
function readCodexConfiguredModel() {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    return raw.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null;
  } catch {
    return null;
  }
}

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
