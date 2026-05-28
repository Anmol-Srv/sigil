/**
 * Onboarding state for the GUI-first first-run wizard.
 *
 * The wizard needs to know:
 *   1. Has the user finished setup before?  (SETUP_COMPLETE flag)
 *   2. What DB are they on, and does it have pgvector + migrations?
 *   3. Which LLM and embedding providers does the user have configured?
 *   4. What client integrations (Claude Code, Cursor, …) are detected?
 *
 * All RPC methods here are LOCAL_ONLY by design — even on a
 * lite-follower the wizard runs on *this* device.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { SIGIL_ENV_PATH } from '../../lib/paths.js';

// Provider field schemas. Each entry is what the GUI renders as a form
// to capture provider credentials. Keeps the existing CLI provider files
// untouched.
const LLM_PROVIDERS = [
  {
    id: 'claude-cli',
    label: 'Claude Code',
    hint: 'Uses your existing Claude Code subscription — no extra API key.',
    recommended: true,
    fields: [],
    env: { LLM_PROVIDER: 'claude-cli' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'One API key for many models (Anthropic, OpenAI, Gemini, …). Cheapest default.',
    fields: [
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', type: 'password', placeholder: 'sk-or-…' },
      { name: 'LLM_OPENROUTER_MODEL', label: 'Model (optional)', type: 'text', placeholder: 'google/gemini-flash-latest', optional: true },
    ],
    env: { LLM_PROVIDER: 'openrouter' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Direct OpenAI access. Requires sk-… key with chat + embeddings.',
    fields: [
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', type: 'password', placeholder: 'sk-…' },
      { name: 'LLM_OPENAI_MODEL', label: 'Model (optional)', type: 'text', placeholder: 'gpt-4o-mini', optional: true },
    ],
    env: { LLM_PROVIDER: 'openai' },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Direct Anthropic API access.',
    fields: [
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', type: 'password', placeholder: 'sk-ant-…' },
    ],
    env: { LLM_PROVIDER: 'anthropic' },
  },
  {
    id: 'ollama',
    label: 'Ollama',
    hint: 'Local Ollama install. Free + private but slower on small machines.',
    fields: [
      { name: 'LLM_OLLAMA_HOST', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434' },
      { name: 'LLM_OLLAMA_MODEL', label: 'Model', type: 'text', placeholder: 'qwen2.5:7b' },
    ],
    env: { LLM_PROVIDER: 'ollama' },
  },
];

const EMBEDDING_PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'text-embedding-3-large @ 1024 dimensions. Best out-of-the-box quality.',
    recommended: true,
    fields: [
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', type: 'password', placeholder: 'sk-…', sharedWith: 'llm' },
    ],
    env: {
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-large',
      EMBEDDING_DIMENSIONS: '1024',
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (nomic-embed-text)',
    hint: '768-dim local embeddings. Free, no key. Lower retrieval quality than OpenAI.',
    fields: [
      { name: 'OLLAMA_HOST', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434' },
    ],
    env: {
      EMBEDDING_PROVIDER: 'ollama',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_DIMENSIONS: '768',
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Uses OpenRouter as an embedding gateway. Reuses your LLM key.',
    fields: [
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', type: 'password', placeholder: 'sk-or-…', sharedWith: 'llm' },
    ],
    env: {
      EMBEDDING_PROVIDER: 'openrouter',
      EMBEDDING_MODEL: 'openai/text-embedding-3-large',
      EMBEDDING_DIMENSIONS: '1024',
    },
  },
];

function readEnvRaw() {
  if (!existsSync(SIGIL_ENV_PATH)) return {};
  const raw = readFileSync(SIGIL_ENV_PATH, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    const v = m[2].trim();
    out[m[1]] = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
      ? v.slice(1, -1)
      : v;
  }
  return out;
}

function writeEnvKeys(patch) {
  const cur = readEnvRaw();
  const next = { ...cur, ...patch };
  // Drop nulls (means "remove this key")
  for (const k of Object.keys(patch)) {
    if (patch[k] === null || patch[k] === undefined) delete next[k];
  }
  mkdirSync(dirname(SIGIL_ENV_PATH), { recursive: true });
  const header = `# Sigil — updated ${new Date().toISOString().slice(0, 10)}\n`;
  const body = Object.entries(next)
    .map(([k, v]) => `${k}=${/[\s#"']/.test(String(v)) ? `"${String(v).replace(/"/g, '\\"')}"` : v}`)
    .join('\n');
  writeFileSync(SIGIL_ENV_PATH, header + body + '\n', 'utf8');
}

export function registerOnboarding(registry) {
  registry.register('onboardingState', async () => {
    const env = readEnvRaw();
    const dbConfigured = Boolean(env.SIGIL_DATABASE_URL || env.SIGIL_DB_HOST);
    const llmConfigured = Boolean(env.LLM_PROVIDER);
    const embConfigured = Boolean(env.EMBEDDING_PROVIDER);
    const setupComplete = env.SIGIL_SETUP_COMPLETE === 'true';

    let dbReady = false;
    let dbPgvector = false;
    let migrationsRan = 0;
    if (dbConfigured) {
      try {
        const { default: cortexDb } = await import('../../db/cortex.js');
        await cortexDb.raw('SELECT 1');
        const ext = await cortexDb.raw("SELECT extname FROM pg_extension WHERE extname = 'vector'");
        dbPgvector = ext.rows.length > 0;
        const [migrated] = await cortexDb('knex_migrations').count('* as n').catch(() => [{ n: 0 }]);
        migrationsRan = Number(migrated?.n ?? 0);
        dbReady = dbPgvector && migrationsRan > 0;
      } catch { /* db not reachable */ }
    }

    return {
      setupComplete,
      env: {
        llmProvider: env.LLM_PROVIDER || null,
        embeddingProvider: env.EMBEDDING_PROVIDER || null,
        embeddingModel: env.EMBEDDING_MODEL || null,
        embeddingDim: env.EMBEDDING_DIMENSIONS || null,
        hasDatabaseUrl: Boolean(env.SIGIL_DATABASE_URL),
        hasDiscreteDb: Boolean(env.SIGIL_DB_HOST),
      },
      steps: {
        database:   { done: dbReady, configured: dbConfigured, pgvector: dbPgvector, migrationsRan },
        llm:        { done: llmConfigured, provider: env.LLM_PROVIDER || null },
        embedding:  { done: embConfigured, provider: env.EMBEDDING_PROVIDER || null },
      },
    };
  });

  registry.register('listLlmProviders',       async () => ({ providers: LLM_PROVIDERS }));
  registry.register('listEmbeddingProviders', async () => ({ providers: EMBEDDING_PROVIDERS }));

  // Persist a provider selection: takes the provider id + the field
  // values the user typed and merges them into ~/.sigil/.env.
  registry.register('configureLlm', async (params) => {
    const provider = LLM_PROVIDERS.find((p) => p.id === params.id);
    if (!provider) {
      const err = new Error(`unknown llm provider: ${params.id}`);
      err.code = 'invalid_params';
      throw err;
    }
    const patch = { ...provider.env };
    for (const f of provider.fields) {
      if (f.optional && !params[f.name]) continue;
      patch[f.name] = params[f.name];
    }
    writeEnvKeys(patch);
    return { ok: true, provider: provider.id, keysWritten: Object.keys(patch) };
  });

  registry.register('configureEmbedding', async (params) => {
    const provider = EMBEDDING_PROVIDERS.find((p) => p.id === params.id);
    if (!provider) {
      const err = new Error(`unknown embedding provider: ${params.id}`);
      err.code = 'invalid_params';
      throw err;
    }
    const patch = { ...provider.env };
    for (const f of provider.fields) {
      if (f.optional && !params[f.name]) continue;
      // sharedWith means the key may already be set by the LLM step
      if (f.sharedWith === 'llm' && !params[f.name]) {
        const existing = readEnvRaw();
        if (existing[f.name]) continue;
      }
      patch[f.name] = params[f.name];
    }
    writeEnvKeys(patch);
    return { ok: true, provider: provider.id, keysWritten: Object.keys(patch) };
  });

  registry.register('markOnboardingComplete', async () => {
    writeEnvKeys({ SIGIL_SETUP_COMPLETE: 'true' });
    // Schedule a soft restart so the daemon re-evaluates env and rebuilds
    // its DB pool against the freshly-saved SIGIL_DATABASE_URL. The CLI
    // / GUI auto-respawn on the next call. (Onboarding finishes regardless
    // — the next dashboard load will pick up the fresh daemon.)
    setTimeout(() => process.exit(0), 250);
    return { ok: true, restarting: true };
  });

  // Explicit daemon recycle — used by the GUI for "Apply changes" buttons.
  registry.register('restartDaemon', async () => {
    setTimeout(() => process.exit(0), 250);
    return { ok: true, restarting: true };
  });

  // Test the active LLM provider end-to-end.
  registry.register('testLlm', async () => {
    try {
      const { prompt } = await import('../../lib/llm.js');
      const out = await prompt('Reply with the single word: ok', { caller: 'onboarding-test' });
      return { ok: true, response: out.slice(0, 200) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  registry.register('testEmbedding', async () => {
    try {
      const { embed } = await import('../../ingestion/embedder.js');
      const v = await embed('Sigil onboarding test');
      if (!Array.isArray(v) || v.length === 0) return { ok: false, error: 'embedder returned empty vector' };
      return { ok: true, dim: v.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
