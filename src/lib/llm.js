import config from '../config.js';
import { getProvider, resolveProviderAndModel, detectProvider } from './llm/registry.js';
import { logCall, calcCost, withRetry } from './llm/log.js';

// --- Resolve which provider + model to use for a given call ---

async function resolveForCall(taskModel) {
  const globalProvider = await detectProvider();
  const resolved = resolveProviderAndModel(taskModel, globalProvider);
  // Warm-session routing: when the resolved provider is the one-shot claude-cli
  // and managed sessions are enabled, swap in the internal managed-session
  // provider. It uses a warm tmux worker inside the daemon and transparently
  // falls through to one-shot claude-cli everywhere else, so callers are
  // unaffected. Only claude-cli is swapped — API providers don't need warming.
  if (resolved.provider === 'claude-cli' && config.llm.managedSession.enabled) {
    return { ...resolved, provider: 'managed-session' };
  }
  return resolved;
}

// --- Public API (unchanged signatures) ---

async function prompt(input, { model, caller, temperature } = {}) {
  const { provider, model: resolvedModel } = await resolveForCall(model);
  const chatFn = await getProvider(provider);
  const start = Date.now();

  try {
    const result = await withRetry(() => chatFn(input, { model: resolvedModel, jsonMode: false, temperature }), config.llm.maxRetries);
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

async function promptJson(input, { model, caller, schema, temperature } = {}) {
  const { provider, model: resolvedModel } = await resolveForCall(model);
  const chatFn = await getProvider(provider);
  const start = Date.now();

  try {
    // `schema` (a JSON Schema) requests provider-enforced structured output.
    // Providers that support it (OpenAI, OpenRouter) constrain decoding to the
    // exact shape; others ignore it and fall back to plain JSON mode.
    const result = await withRetry(() => chatFn(input, { model: resolvedModel, jsonMode: true, schema, temperature }), config.llm.maxRetries);
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

  const jsonMatch = text.match(/[[{][\s\S]*[\]}]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* not valid JSON */ }
  }

  return null;
}

export { prompt, promptJson, parseJson };
