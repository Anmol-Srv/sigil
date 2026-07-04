import { getConfig } from './setup/config-store.js';
import { EMBEDDING_DIM } from './lib/constants.js';

// config.json (the config-store) is the SINGLE SOURCE OF TRUTH for ALL
// configuration — database, llm, embedding, plus every infra/tuning section
// (http, network, memory, search, ingest, output, hebbian, managed-session).
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
    type: 'postgres',
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

    // OpenRouter — OpenAI-compatible gateway; one key, namespaced models
    // like "anthropic/claude-sonnet-latest", "openai/gpt-mini-latest", etc.
    // Default is Gemini Flash latest — best singular all-rounder at current
    // OpenRouter pricing: $0.0005/$0.003 per 1M tokens, 1M context, strong
    // JSON output, ~500ms typical latency. Beats Claude Haiku 2× on cost
    // and 5× on context while matching reasoning + JSON reliability for
    // Sigil's call types (extraction, AUDM, classifier, router, synthesis).
    get openrouterApiKey() { return llmKey('openrouter'); },
    get openrouterModel() { return llmModel('openrouter') || 'google/gemini-flash-latest'; },
    get openrouterBaseUrl() { return store().llm.openrouterBaseUrl ?? ''; },
    get openrouterReferer() { return store().llm.openrouterReferer ?? 'https://github.com/Anmol-Srv/sigil'; },
    get openrouterTitle() { return store().llm.openrouterTitle ?? 'Sigil'; },

    // Per-task model overrides (use provider-specific model names)
    get extractionModel() { return store().llm.extractionModel ?? ''; },
    get decisionModel() { return store().llm.decisionModel ?? ''; },
    get entityModel() { return store().llm.entityModel ?? ''; },

    get maxRetries() { return Number(store().llm.maxRetries ?? 3) || 3; },
    get cliTimeout() { return Number(store().llm.cliTimeout ?? 120000) || 120000; },
    // Hard ceiling on CONCURRENT `claude` CLI processes spawned by THIS process.
    // The blowup this caps: a user once hit 1600+ live `claude` sessions when an
    // ingest fan-out (and fallback storms) spawned one process per call with no
    // bound — pinning RAM/tokens. Every `claude` spawn (one-shot path, managed-
    // session fallback, hook classify) routes through one semaphore, so excess
    // calls QUEUE instead of forking. Per-process: the daemon is the process that
    // fans out, so its singleton gate is what matters; short-lived hooks spawn ≤1
    // anyway. Default 4 keeps throughput while making the 1600 case impossible.
    get maxClaudeProcs() { return Math.max(1, Number(store().llm.maxClaudeProcs ?? 4) || 4); },

    // Managed-session engine (warm tmux workers; see src/lib/llm/session/).
    // Opt-in in v1: a NEW subsystem, so default OFF — when disabled the
    // managed-session provider transparently uses the one-shot claude-cli path,
    // so nothing breaks. Enable to amortize agentic cold-start across many
    // ingest calls. Only meaningful on a host with `tmux` and the `claude` CLI.
    managedSession: {
      get enabled() { return store().llm.managedSession?.enabled === true; },
      // Workers per source type. 1 = strictly serial per engine (matches the
      // "one session per source type" model); raise to lift the serial-latency
      // ceiling. Bounded RAM = poolSize × live agent processes per type.
      get poolSize() { return Math.max(1, Number(store().llm.managedSession?.poolSize ?? 1) || 1); },
      // Recycle a worker once it has processed ~this many tokens (the "context
      // cap" / budget-window reset). Caps cross-task context bleed + memory creep.
      get tokenBudget() { return Number(store().llm.managedSession?.tokenBudget ?? 60000) || 60000; },
      // Dead-man timeout per task → one-shot fallback + recycle.
      get taskTimeoutMs() { return Number(store().llm.managedSession?.taskTimeoutMs ?? 120000) || 120000; },
      // Boot handshake window: how long to wait for a freshly-spawned worker's
      // first get_task before re-nudging once, then recycling. Keeps a lost
      // cold-boot keystroke to a short retry instead of a full dead-man timeout.
      get firstTaskTimeoutMs() { return Number(store().llm.managedSession?.firstTaskTimeoutMs ?? 10000) || 10000; },
      // How often the daemon sweeps BUSY workers for a wedged interactive dialog
      // (catches a stuck auth/trust prompt before its dead-man timeout fires).
      get healthProbeMs() { return Number(store().llm.managedSession?.healthProbeMs ?? 15000) || 15000; },
      // Escape hatch: /clear between tasks (default on). false → prompt-ordering only.
      get clearBetweenTasks() { return store().llm.managedSession?.clearBetweenTasks !== false; },
    },
    // HTTP request timeout for network LLM providers/embedders (OpenAI,
    // OpenRouter, Voyage). Without it a hung connection blocks the daemon or a
    // hook indefinitely. 60s leaves headroom for large JSON completions while
    // still bounding a dead socket. Local Ollama generation uses cliTimeout
    // (it can legitimately run longer); claude-cli uses cliTimeout too.
    get requestTimeout() { return Number(store().llm.requestTimeout ?? 60000) || 60000; },
  },

  // The sections below are infra/tuning. config.json owns them (defaults merged
  // on read by getConfig), so each getter just returns its store section — no
  // env. Mutable knobs change live via patchConfig without a daemon restart.
  get output() { return store().output; },
  get http() { return store().http; },
  // 'solo' | 'master' | 'follower' | 'lite-follower'. `enabled` is stored
  // explicitly now (was derived from mode via env); `sigil join` sets both.
  get network() { return store().network; },
  get defaults() { return store().defaults; },
  // AUDM dedup/supersession + search floors. See config-store defaults() for the
  // tuned values; change via patchConfig('memory', {...}) or the GUI.
  get memory() { return store().memory; },
  get search() { return store().search; },
  get ingest() { return store().ingest; },
  get hebbian() { return store().hebbian; },
  // User preferences (noUpdateCheck, …) — was SIGIL_NO_UPDATE_CHECK env.
  get preferences() { return store().preferences; },
  // Read-time owner-scoping of private-kind pods (P2). config.json owns it;
  // change via patchConfig('privacy',{scope}) — 'device' enforces, 'off' disables.
  get privacy() { return store().privacy; },
};

export default config;
