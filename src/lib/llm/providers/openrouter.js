/**
 * OpenRouter provider.
 *
 * OpenRouter is an OpenAI-compatible API gateway in front of many model
 * vendors (Anthropic, OpenAI, Meta, Mistral, Google, ...). One key, one
 * base URL, many models — model names are namespaced like
 * "anthropic/claude-sonnet-4-5" or "openai/gpt-4o".
 *
 * This provider reuses the OpenAI chat-completions response shape; only
 * the base URL, auth, and optional analytics headers (HTTP-Referer +
 * X-Title) differ.
 *
 * Docs: https://openrouter.ai/docs
 */

import config from '../../../config.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

async function chat(input, { model, jsonMode = false, schema = null, temperature } = {}) {
  const resolved = model || config.llm.openrouterModel;
  if (!config.llm.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!resolved) {
    throw new Error('No OpenRouter model resolved. Set LLM_OPENROUTER_MODEL or pass `model`.');
  }

  const messages = [{ role: 'user', content: input }];
  if (jsonMode && !input.toLowerCase().includes('json')) {
    messages.unshift({ role: 'system', content: 'Respond with valid JSON.' });
  }

  const body = { model: resolved, messages };
  if (temperature != null) body.temperature = temperature;
  // Schema-constrained structured output forces the exact response shape — far
  // more reliable on small models than free-form json_object mode. OpenRouter
  // proxies this to providers that support it and emulates it for others.
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'sigil_response', strict: true, schema } };
  } else if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const baseUrl = (config.llm.openrouterBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.llm.openrouterApiKey}`,
  };
  // OpenRouter uses HTTP-Referer + X-Title for app attribution in their
  // analytics dashboard. Optional but they ask nicely.
  if (config.llm.openrouterReferer) headers['HTTP-Referer'] = config.llm.openrouterReferer;
  if (config.llm.openrouterTitle) headers['X-Title'] = config.llm.openrouterTitle;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.llm.requestTimeout),
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  const data = await response.json();
  // OpenRouter returns the OpenAI shape, but some upstream providers omit
  // usage. Guard against missing fields.
  const choice = data.choices?.[0];
  const text = (choice?.message?.content || '').trim();
  const usage = data.usage || {};

  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    model: data.model || resolved,
  };
}

export { chat };
