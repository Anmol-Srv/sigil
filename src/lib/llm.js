import config from '../config.js';
import { getProvider, resolveProviderAndModel, detectProvider } from './llm/registry.js';
import { withRetry } from './llm/log.js';

// --- Resolve which provider + model to use for a given call ---

async function resolveForCall(taskModel) {
  const globalProvider = await detectProvider();
  return resolveProviderAndModel(taskModel, globalProvider);
}

// --- Public API (unchanged signatures) ---

async function prompt(input, { model, caller, temperature } = {}) {
  const { provider, model: resolvedModel } = await resolveForCall(model);
  const chatFn = await getProvider(provider);
  const result = await withRetry(
    () => chatFn(input, { model: resolvedModel, jsonMode: false, temperature, caller }),
    config.llm.maxRetries,
  );
  return result.text;
}

async function promptJson(input, { model, caller, schema, temperature } = {}) {
  const { provider, model: resolvedModel } = await resolveForCall(model);
  const chatFn = await getProvider(provider);
  // `schema` requests provider-enforced structured output where supported;
  // other providers fall back to ordinary JSON mode.
  const result = await withRetry(
    () => chatFn(input, { model: resolvedModel, jsonMode: true, schema, temperature, caller }),
    config.llm.maxRetries,
  );
  return parseJson(result.text);
}

function parseJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch { /* not raw JSON */ }

  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch { /* invalid JSON in code block */ }
  }

  const jsonMatch = text.match(/[[{][\s\S]*[\]}]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* not valid JSON */ }
  }

  return null;
}

export { prompt, promptJson, parseJson };
