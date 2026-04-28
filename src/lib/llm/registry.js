import { spawn } from 'node:child_process';

import config from '../../config.js';

// --- Lazy provider loading ---

const PROVIDERS = {
  openai: () => import('./providers/openai.js'),
  anthropic: () => import('./providers/anthropic.js'),
  'claude-cli': () => import('./providers/claude-cli.js'),
  ollama: () => import('./providers/ollama.js'),
};

const EMBEDDERS = {
  ollama: () => import('./embedders/ollama.js'),
  openai: () => import('./embedders/openai.js'),
};

const providerCache = {};
const embedderCache = {};

async function getProvider(name) {
  if (!providerCache[name]) {
    const loader = PROVIDERS[name];
    if (!loader) throw new Error(`Unknown LLM provider: "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
    const mod = await loader();
    providerCache[name] = mod.chat;
  }
  return providerCache[name];
}

async function getEmbedder(name) {
  if (!embedderCache[name]) {
    const loader = EMBEDDERS[name];
    if (!loader) throw new Error(`Unknown embedding provider: "${name}". Available: ${Object.keys(EMBEDDERS).join(', ')}`);
    const mod = await loader();
    embedderCache[name] = mod.embedBatch;
  }
  return embedderCache[name];
}

// --- Provider:model resolution ---

function resolveProviderAndModel(taskModel, defaultProvider) {
  if (!taskModel) return { provider: defaultProvider, model: null };

  // Support "provider:model" compound syntax
  const colonIdx = taskModel.indexOf(':');
  if (colonIdx > 0 && PROVIDERS[taskModel.slice(0, colonIdx)]) {
    return {
      provider: taskModel.slice(0, colonIdx),
      model: taskModel.slice(colonIdx + 1),
    };
  }

  return { provider: defaultProvider, model: taskModel };
}

// --- Auto-detection ---

let detectedProvider = null;
let detectedEmbedder = null;

async function isOllamaReachable() {
  const host = config.llm.ollamaHost || config.embedding.ollamaHost || 'http://localhost:11434';
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function isClaudeCliAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], { stdio: 'pipe' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    setTimeout(() => { proc.kill(); resolve(false); }, 3000);
  });
}

async function detectProvider() {
  if (detectedProvider) return detectedProvider;

  // Explicit config always wins
  if (config.llm.provider) {
    detectedProvider = config.llm.provider;
    return detectedProvider;
  }

  // Check API keys first (fastest, most reliable)
  if (config.llm.apiKey) { detectedProvider = 'anthropic'; return detectedProvider; }
  if (config.llm.openaiApiKey) { detectedProvider = 'openai'; return detectedProvider; }

  // Check local services
  if (await isOllamaReachable()) { detectedProvider = 'ollama'; return detectedProvider; }
  if (await isClaudeCliAvailable()) { detectedProvider = 'claude-cli'; return detectedProvider; }

  throw new Error(
    'No LLM provider available. Either:\n'
    + '  - Set LLM_PROVIDER (openai, anthropic, ollama, claude-cli)\n'
    + '  - Set ANTHROPIC_API_KEY or OPENAI_API_KEY\n'
    + '  - Start Ollama locally\n'
    + '  - Install the Claude CLI (claude)',
  );
}

async function detectEmbeddingProvider() {
  if (detectedEmbedder) return detectedEmbedder;

  if (config.embedding.provider) {
    detectedEmbedder = config.embedding.provider;
    return detectedEmbedder;
  }

  if (await isOllamaReachable()) { detectedEmbedder = 'ollama'; return detectedEmbedder; }
  if (config.embedding.openaiApiKey) { detectedEmbedder = 'openai'; return detectedEmbedder; }

  throw new Error(
    'No embedding provider available. Either:\n'
    + '  - Set EMBEDDING_PROVIDER (ollama, openai)\n'
    + '  - Start Ollama locally\n'
    + '  - Set OPENAI_API_KEY',
  );
}

// Reset detection cache (for testing)
function resetDetection() {
  detectedProvider = null;
  detectedEmbedder = null;
}

export {
  getProvider,
  getEmbedder,
  resolveProviderAndModel,
  detectProvider,
  detectEmbeddingProvider,
  resetDetection,
  isOllamaReachable,
  isClaudeCliAvailable,
};
