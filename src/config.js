import { getConfig } from './setup/config-store.js';
import { EMBEDDING_DIM } from './lib/constants.js';

// config.json (the config-store) is the SINGLE SOURCE OF TRUTH for ALL
// configuration — database, llm, embedding, plus each active infra/tuning
// section (http, memory, ingest).
// Getters read the store ONLY; no env var is ever consulted for config, so a
// stray global (e.g. LLM_PROVIDER=openai) can never override what onboarding
// saved. Defaults live in code (config-store defaults()) and merge on read
// (§7.2 of docs/building-core-system-cli-apps.md), so the on-disk file stays
// sparse, defaults track the code, and every store section always has all fields.
//
// The ONLY env that remains is true bootstrap / runtime / process-identity that
// physically cannot live in config.json: HOME (locates config.json itself),
// SIGIL_DAEMON_PROCESS / SIGIL_AGENT / SIGIL_WORKER_ID / SIGIL_SOURCE / SIGIL_SUPERVISED
// (per-process identity + IPC), SIGIL_PGLITE_PATH (launch/test DB-path redirect),
// SIGIL_BRANCH (release-lane selector, set by install.sh), and OS/debug flags
// (SHELL, DISPLAY, SIGIL_DEBUG). Per-invocation CLI flags may still override
// transiently — they're explicit one-shot intent, not a file.
const store = () => getConfig();
// The setup steps store ONE apiKey/model per chosen provider; expose it only
// through the matching provider's getter so detection + the provider module
// line up.
const llmKey = (provider) => (store().llm.provider === provider ? store().llm.apiKey || '' : '');
const llmModel = (provider) => (store().llm.provider === provider ? store().llm.model || '' : '');
const embKey = (provider) => (store().embedding.provider === provider ? store().embedding.apiKey || '' : '');

const config = {
  // Live getters off the store (not frozen values): the GUI/CLI patch config.json
  // mid-session (e.g. the onboarding DB step), so a freshly-configured database is
  // seen without a restart — and the dim-conflict check (inspectEmbeddingCompat →
  // selectDriver(config)) never probes a stale DB. Reads the store at access time.
  db: {
    // Persistence mode: 'embedded' (in-process PGlite, zero prerequisites),
    // 'local'/'docker' (discrete host/port fields), or 'url' (connection
    // string). Read live from the store so a mid-session onboarding switch is
    // picked up without a restart.
    get mode() { return store().database.mode ?? null; },
    // Connection URL takes precedence when set. Recognized providers
    // (Neon, Supabase, RDS, Render, Railway, CockroachDB) get sensible
    // SSL defaults automatically; override with ?sslmode=... in the URL.
    get url() { return store().database.url ?? null; },
    get host() { return store().database.host ?? 'localhost'; },
    get port() { return Number(store().database.port ?? 5432); },
    get database() { return store().database.name ?? 'sigil'; },
    get user() { return store().database.user ?? 'sigil_app'; },
    get password() { return store().database.password ?? ''; },
  },

  // Live getters off the store: `sigil init`/the GUI patch config.json during
  // provider selection, so reads reflect what was just written (e.g. picking
  // OpenAI updates the model/key immediately). The embed path reads these live
  // via `{...config.embedding}`.
  embedding: {
    get provider() { return store().embedding.provider ?? ''; },
    get model() { return store().embedding.model ?? 'mxbai-embed-large'; },
    // Fixed, non-configurable: the DB schema and every provider are pinned to
    // this so they can never drift (see src/lib/constants.js).
    get dimensions() { return EMBEDDING_DIM; },
    get ollamaHost() { return (store().embedding.provider === 'ollama' ? store().embedding.host : '') || 'http://localhost:11434'; },
    get openaiApiKey() { return embKey('openai'); },
    get voyageApiKey() { return embKey('voyage'); },
    // OpenRouter as an embedding gateway. Models are namespaced (e.g.
    // "openai/text-embedding-3-large", "voyageai/voyage-3-large").
    // Reuses the chat-side referer/title for app attribution.
    get openrouterApiKey() { return embKey('openrouter'); },
    get openrouterBaseUrl() { return store().embedding.openrouterBaseUrl ?? ''; },
    get openrouterReferer() { return store().embedding.openrouterReferer ?? 'https://github.com/Anmol-Srv/sigil'; },
    get openrouterTitle() { return store().embedding.openrouterTitle ?? 'Sigil'; },
  },

  // Live getters off the store — same rationale as `embedding` above, so
  // `testLlm` tests the provider the user just picked, not a boot-time snapshot.
  llm: {
    get provider() { return store().llm.provider ?? ''; },

    // OpenAI
    get openaiApiKey() { return llmKey('openai'); },
    get openaiModel() { return llmModel('openai') || 'gpt-4o-mini'; },

    // Ollama
    get ollamaHost() { return (store().llm.provider === 'ollama' ? store().llm.host : '') || 'http://localhost:11434'; },
    get ollamaModel() { return llmModel('ollama') || 'qwen2.5:7b'; },

    // Claude CLI (dev — uses your Claude Code subscription)
    get cliModel() { return llmModel('claude-cli') || 'haiku'; },
    // Explicit path to the `claude` binary. Optional — when unset the
    // provider auto-resolves it (see providers/claude-cli.js). Needed when
    // the daemon runs under launchd/systemd with a stripped PATH that can't
    // see ~/.local/bin or the nvm bin dir where `claude` lives.
    get cliPath() { return store().llm.cliPath ?? ''; },

    // Anthropic
    get apiKey() { return llmKey('anthropic'); },

    // OpenRouter — OpenAI-compatible gateway; one key and namespaced models.
    // Generation is optional and used only by explicitly requested enrichment.
    get openrouterApiKey() { return llmKey('openrouter'); },
    get openrouterModel() { return llmModel('openrouter') || 'google/gemini-flash-latest'; },
    get openrouterBaseUrl() { return store().llm.openrouterBaseUrl ?? ''; },
    get openrouterReferer() { return store().llm.openrouterReferer ?? 'https://github.com/Anmol-Srv/sigil'; },
    get openrouterTitle() { return store().llm.openrouterTitle ?? 'Sigil'; },

    // Optional extraction-model override (use a provider-specific model name).
    get extractionModel() { return store().llm.extractionModel ?? ''; },

    get maxRetries() { return Math.max(1, Number(store().llm.maxRetries ?? 1) || 1); },
    get cliTimeout() { return Number(store().llm.cliTimeout ?? 120000) || 120000; },
    // Per-process guard for explicit Claude CLI generation.
    get maxClaudeProcs() { return Math.max(1, Number(store().llm.maxClaudeProcs ?? 1) || 1); },

    // HTTP request timeout for network LLM providers/embedders (OpenAI,
    // OpenRouter, Voyage). Without it a hung connection blocks the daemon or a
    // hook indefinitely. 60s leaves headroom for large JSON completions while
    // still bounding a dead socket. Local Ollama generation uses cliTimeout
    // (it can legitimately run longer); claude-cli uses cliTimeout too.
    get requestTimeout() { return Number(store().llm.requestTimeout ?? 60000) || 60000; },
  },

  // The sections below are infra/tuning. config.json owns them.
  get http() { return store().http; },
  get defaults() { return store().defaults; },
  // Search candidate and automatic-injection floors.
  get memory() { return store().memory; },
  get ingest() { return store().ingest; },
};

export default config;
