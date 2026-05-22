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

// ─── Init metadata + setup ──────────────────────────────────────────────────
// `setup` is called by `sigil init` when the user picks this provider. It
// owns the prompts, validation, and env-key shape for OpenAI. Returns
// `{ env: {...} }` on success or `null` if the user cancelled — the
// orchestrator translates `null` into a clean exit.
const meta = {
  id: 'openai',
  label: 'OpenAI',
  hint: 'gpt-4o-mini',
};

async function setup({ existing, clack }) {
  const current = existing.OPENAI_API_KEY || '';
  const key = await clack.text({
    message: 'OpenAI API key (paste, then Enter)',
    placeholder: current ? '(keep existing — press Enter)' : 'sk-proj-...',
    validate: (v) => {
      if (!v && !current) return 'API key is required';
      if (v && !v.startsWith('sk-')) return 'OpenAI keys start with "sk-" — check paste';
    },
  });
  if (clack.isCancel(key)) return null;

  return { env: { OPENAI_API_KEY: key || current } };
}

export { chat, meta, setup };
