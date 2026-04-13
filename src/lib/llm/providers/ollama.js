import config from '../../../config.js';
import { estimateTokens } from '../log.js';

async function chat(input, { model, jsonMode = false } = {}) {
  const resolved = model || config.llm.ollamaModel;
  const url = `${config.llm.ollamaHost}/api/chat`;

  const body = {
    model: resolved,
    messages: [{ role: 'user', content: input }],
    stream: false,
  };
  if (jsonMode) body.format = 'json';

  const response = await fetch(url, {
    method: 'POST',
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
