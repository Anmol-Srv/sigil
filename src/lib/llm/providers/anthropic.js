import config from '../../../config.js';
import { estimateTokens } from '../log.js';

let client = null;

async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.llm.apiKey });
  }
  return client;
}

async function chat(input, { model, jsonMode = false } = {}) {
  const resolved = model || 'claude-haiku-4-5-20251001';
  const anthropic = await getClient();

  const messages = [{ role: 'user', content: input }];
  const system = jsonMode ? 'Respond with valid JSON only. No explanation or wrapping.' : undefined;

  const message = await anthropic.messages.create({
    model: resolved,
    max_tokens: 4096,
    messages,
    ...(system && { system }),
  });

  return {
    text: message.content[0].text.trim(),
    inputTokens: message.usage?.input_tokens || estimateTokens(input),
    outputTokens: message.usage?.output_tokens || estimateTokens(message.content[0].text),
    model: resolved,
  };
}

export { chat };
