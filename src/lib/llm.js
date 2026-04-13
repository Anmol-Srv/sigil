import config from '../config.js';
import { getProvider, resolveProviderAndModel, detectProvider } from './llm/registry.js';
import { logCall, calcCost, withRetry } from './llm/log.js';

// --- Resolve which provider + model to use for a given call ---

async function resolveForCall(taskModel) {
  const globalProvider = await detectProvider();
  return resolveProviderAndModel(taskModel, globalProvider);
}

// --- Public API (unchanged signatures) ---

async function prompt(input, { model, caller } = {}) {
  const { provider, model: resolvedModel } = await resolveForCall(model);
  const chatFn = await getProvider(provider);
  const start = Date.now();

  try {
    const result = await withRetry(() => chatFn(input, { model: resolvedModel, jsonMode: false }), config.llm.maxRetries);
    const cost = result.cost || calcCost(result.model, result.inputTokens, result.outputTokens);

    logCall({
      provider, model: result.model, caller,
      input, response: result.text,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      cost, durationMs: Date.now() - start, status: 'success',
    });

    return result.text;
  } catch (err) {
    logCall({
      provider, model: resolvedModel, caller,
      input, response: null,
      inputTokens: 0, outputTokens: 0,
      cost: 0, durationMs: Date.now() - start, status: 'error', error: err.message,
    });
    throw err;
  }
}

async function promptJson(input, { model, caller } = {}) {
  const { provider, model: resolvedModel } = await resolveForCall(model);
  const chatFn = await getProvider(provider);
  const start = Date.now();

  try {
    const result = await withRetry(() => chatFn(input, { model: resolvedModel, jsonMode: true }), config.llm.maxRetries);
    const cost = result.cost || calcCost(result.model, result.inputTokens, result.outputTokens);

    logCall({
      provider, model: result.model, caller,
      input, response: result.text,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      cost, durationMs: Date.now() - start, status: 'success',
    });

    return parseJson(result.text);
  } catch (err) {
    logCall({
      provider, model: resolvedModel, caller,
      input, response: null,
      inputTokens: 0, outputTokens: 0,
      cost: 0, durationMs: Date.now() - start, status: 'error', error: err.message,
    });
    throw err;
  }
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

  const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* not valid JSON */ }
  }

  return null;
}

export { prompt, promptJson, parseJson };
