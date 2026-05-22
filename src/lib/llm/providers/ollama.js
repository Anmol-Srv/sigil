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

// ─── Init metadata + setup ──────────────────────────────────────────────────
// `setup` only collects OLLAMA_HOST. The daemon health-check + model-pull
// dance lives in the init orchestrator (it is shared between LLM and
// embedder paths — duplicating it here would re-introduce the spawn / wait
// / pull logic in two provider modules).
const meta = {
  id: 'ollama',
  label: 'Ollama',
  hint: 'local models — no API cost',
};

async function setup({ existing, clack }) {
  const current = existing.OLLAMA_HOST || 'http://localhost:11434';
  const host = await clack.text({
    message: 'Ollama host',
    placeholder: current,
    initialValue: current,
    validate: (v) => {
      if (v && !/^https?:\/\//.test(v)) return 'Must start with http:// or https://';
    },
  });
  if (clack.isCancel(host)) return null;

  return { env: { OLLAMA_HOST: host || current } };
}

export { chat, meta, setup };
