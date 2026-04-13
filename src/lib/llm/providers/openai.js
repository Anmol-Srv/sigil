import config from '../../../config.js';

async function chat(input, { model, jsonMode = false } = {}) {
  const resolved = model || config.llm.openaiModel;
  const messages = [{ role: 'user', content: input }];

  if (jsonMode && !input.toLowerCase().includes('json')) {
    messages.unshift({ role: 'system', content: 'Respond with valid JSON.' });
  }

  const body = { model: resolved, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content.trim();
  const usage = data.usage || {};

  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    model: resolved,
  };
}

export { chat };
