import config from '../../../config.js';
import { estimateTokens } from '../log.js';

async function chat(input, { model, jsonMode = false, temperature } = {}) {
  const resolved = model || config.llm.ollamaModel;
  const url = `${config.llm.ollamaHost}/api/chat`;

  const body = {
    model: resolved,
    messages: [{ role: 'user', content: input }],
    stream: false,
  };
  if (jsonMode) body.format = 'json';
  // Ollama nests sampling params under `options`.
  if (temperature != null) body.options = { ...(body.options || {}), temperature };

  const response = await fetch(url, {
    method: 'POST',
    // Local generation can run long — give it the CLI generation budget, not
    // the shorter network-request timeout, so we don't kill legitimate work.
    signal: AbortSignal.timeout(config.llm.cliTimeout),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json();

  return {
    text: data.message.content.trim(),
    inputTokens: data.prompt_eval_count || estimateTokens(input),
    outputTokens: data.eval_count || estimateTokens(data.message.content),
    model: resolved,
  };
}

export { chat };
