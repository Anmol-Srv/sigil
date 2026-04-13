import cortexDb from '../../db/cortex.js';

// Approximate cost per 1M tokens by model
const COST_PER_M = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function calcCost(model, inputTokens, outputTokens) {
  const rates = COST_PER_M[model];
  if (!rates) return 0;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

function logCall({ provider, model, caller, input, response, inputTokens, outputTokens, cost, durationMs, status, error }) {
  cortexDb('llm_log')
    .insert({
      provider,
      model,
      caller,
      input: input?.slice(0, 10000),
      response: response?.slice(0, 10000),
      inputTokens,
      outputTokens,
      cost,
      durationMs,
      status,
      error: error?.slice(0, 2000),
    })
    .catch((err) => console.error('[llm-log] Write failed:', err.message));
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export { estimateTokens, calcCost, logCall, withRetry };
