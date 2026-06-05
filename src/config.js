import { getConfig } from './setup/config-store.js';
import { EMBEDDING_DIM } from './lib/constants.js';

const env = (key, fallback) => process.env[key] ?? fallback;

// Device-local config (config.json). Precedence everywhere below is
// `process.env  ||  config-store  ||  hard default` — so an explicit env var
// still wins (dev / tests / CI), but with no env set the saved config.json
// drives, instead of a stale ~/.sigil/.env. Tuning flags (MEMORY_*, ports, …)
// stay env-only; only onboarding-managed sections read the store.
const store = () => getConfig();
// The setup steps store ONE apiKey/model per chosen provider; expose it only
// through the matching provider's getter so detection + the provider module
// line up.
const llmKey = (provider) => (store().llm.provider === provider ? store().llm.apiKey || '' : '');
const llmModel = (provider) => (store().llm.provider === provider ? store().llm.model || '' : '');
const embKey = (provider) => (store().embedding.provider === provider ? store().embedding.apiKey || '' : '');

const dbType = env('SIGIL_DB_TYPE', 'postgres');
if (dbType !== 'postgres') {
  throw new Error(
    `SIGIL_DB_TYPE=${dbType} is no longer supported. Sigil 0.10.0+ is Postgres-only.\n`
    + 'PGlite was deprecated; existing PGlite data at ~/.sigil/db is preserved but unreachable from this version.\n'
    + 'Set SIGIL_DB_TYPE=postgres in ~/.sigil/.env and configure SIGIL_DB_HOST / PORT / NAME / USER / PASSWORD.\n'
    + 'Run `sigil init` for an interactive setup.',
  );
}

const config = {
  // Env-derived getters (not frozen values): the GUI/CLI rewrite ~/.sigil/.env
  // mid-session (e.g. the onboarding DB step) and then dotenv-override
  // process.env. Plain values would freeze at the daemon's boot-time env, so a
  // freshly-configured database wouldn't be seen until restart — and the
  // dim-conflict check (inspectEmbeddingCompat → selectDriver(config)) would
  // probe the stale DB. Getters read process.env at access time. Same fix
  // class as the `embedding` block below.
  db: {
    type: 'postgres',
    // Persistence mode: 'embedded' (in-process PGlite, zero prerequisites),
    // 'local'/'docker' (discrete host/port fields), or 'url' (connection
    // string). Read live so a mid-session onboarding switch is picked up.
    // Env escape hatch: SIGIL_DB_MODE=embedded forces the embedded engine.
    get mode() { return process.env.SIGIL_DB_MODE || store().database.mode || null; },
    // Connection URL takes precedence when set. Recognized providers
    // (Neon, Supabase, RDS, Render, Railway, CockroachDB) get sensible
    // SSL defaults automatically; override with ?sslmode=... in the URL.
    get url() { return (process.env.SIGIL_DATABASE_URL || process.env.DATABASE_URL) || store().database.url || null; },
    get host() { return process.env.SIGIL_DB_HOST || store().database.host || 'localhost'; },
    get port() { return Number(process.env.SIGIL_DB_PORT || store().database.port || 5432); },
    get database() { return process.env.SIGIL_DB_NAME || store().database.name || 'sigil'; },
    get user() { return process.env.SIGIL_DB_USER || store().database.user || 'sigil_app'; },
    get password() { return process.env.SIGIL_DB_PASSWORD || store().database.password || ''; },
  },

  // Env-derived getters (not frozen values): `sigil init` writes a fresh
  // ~/.sigil/.env and then dotenv-overrides process.env AFTER this module has
  // already been imported (registry.js pulls config in during provider
  // selection). Plain values would freeze at the pre-init env — e.g. picking
  // OpenAI@1024 but still embedding at the old 768 default. Getters read
  // process.env at access time, so the post-override env wins. The embed path
  // reads these live via `{...config.embedding}`, so truncation dimensions and
  // keys reflect what init just wrote.
  embedding: {
    get provider() { return process.env.EMBEDDING_PROVIDER || store().embedding.provider || ''; },
    get model() { return process.env.EMBEDDING_MODEL || store().embedding.model || 'mxbai-embed-large'; },
    // Fixed, non-configurable: the DB schema and every provider are pinned to
    // this so they can never drift (see src/lib/constants.js).
    get dimensions() { return EMBEDDING_DIM; },
    get ollamaHost() { return process.env.OLLAMA_HOST || (store().embedding.provider === 'ollama' ? store().embedding.host : '') || 'http://localhost:11434'; },
    get openaiApiKey() { return process.env.OPENAI_API_KEY || embKey('openai'); },
    get voyageApiKey() { return process.env.VOYAGE_API_KEY || embKey('voyage'); },
    // OpenRouter as an embedding gateway. Models are namespaced (e.g.
    // "openai/text-embedding-3-large", "voyageai/voyage-3-large").
    // Reuses the chat-side referer/title for app attribution.
    get openrouterApiKey() { return process.env.OPENROUTER_API_KEY || embKey('openrouter'); },
    openrouterBaseUrl: process.env.EMBEDDING_OPENROUTER_BASE_URL || process.env.LLM_OPENROUTER_BASE_URL || '',
    openrouterReferer: process.env.EMBEDDING_OPENROUTER_REFERER || process.env.LLM_OPENROUTER_REFERER || 'https://github.com/Anmol-Srv/sigil',
    openrouterTitle: process.env.EMBEDDING_OPENROUTER_TITLE || process.env.LLM_OPENROUTER_TITLE || 'Sigil',
  },

  // Env-derived getters — same rationale as `embedding` above. The onboarding
  // wizard writes ~/.sigil/.env mid-session and reloads process.env, so plain
  // values would freeze at boot-time env and `testLlm` would test the old
  // provider instead of the one the user just picked.
  llm: {
    get provider() { return process.env.LLM_PROVIDER || store().llm.provider || ''; },

    // OpenAI
    get openaiApiKey() { return process.env.OPENAI_API_KEY || llmKey('openai'); },
    get openaiModel() { return process.env.LLM_OPENAI_MODEL || llmModel('openai') || 'gpt-4o-mini'; },

    // Ollama
    get ollamaHost() { return process.env.LLM_OLLAMA_HOST || process.env.OLLAMA_HOST || (store().llm.provider === 'ollama' ? store().llm.host : '') || 'http://localhost:11434'; },
    get ollamaModel() { return process.env.LLM_OLLAMA_MODEL || llmModel('ollama') || 'qwen2.5:7b'; },

    // Claude CLI (dev — uses your Claude Code subscription)
    get cliModel() { return process.env.LLM_CLI_MODEL || llmModel('claude-cli') || 'haiku'; },
    // Explicit path to the `claude` binary. Optional — when unset the
    // provider auto-resolves it (see providers/claude-cli.js). Needed when
    // the daemon runs under launchd/systemd with a stripped PATH that can't
    // see ~/.local/bin or the nvm bin dir where `claude` lives.
    get cliPath() { return process.env.LLM_CLI_PATH || ''; },

    // Anthropic
    get apiKey() { return process.env.ANTHROPIC_API_KEY || llmKey('anthropic'); },

    // OpenRouter — OpenAI-compatible gateway; one key, namespaced models
    // like "anthropic/claude-sonnet-latest", "openai/gpt-mini-latest", etc.
    // Default is Gemini Flash latest — best singular all-rounder at current
    // OpenRouter pricing: $0.0005/$0.003 per 1M tokens, 1M context, strong
    // JSON output, ~500ms typical latency. Beats Claude Haiku 2× on cost
    // and 5× on context while matching reasoning + JSON reliability for
    // Sigil's call types (extraction, AUDM, classifier, router, synthesis).
    get openrouterApiKey() { return process.env.OPENROUTER_API_KEY || llmKey('openrouter'); },
    get openrouterModel() { return process.env.LLM_OPENROUTER_MODEL || llmModel('openrouter') || 'google/gemini-flash-latest'; },
    get openrouterBaseUrl() { return process.env.LLM_OPENROUTER_BASE_URL || ''; },
    get openrouterReferer() { return process.env.LLM_OPENROUTER_REFERER || 'https://github.com/Anmol-Srv/sigil'; },
    get openrouterTitle() { return process.env.LLM_OPENROUTER_TITLE || 'Sigil'; },

    // Per-task model overrides (use provider-specific model names)
    get extractionModel() { return process.env.LLM_EXTRACTION_MODEL || ''; },
    get decisionModel() { return process.env.LLM_DECISION_MODEL || ''; },
    get entityModel() { return process.env.LLM_ENTITY_MODEL || ''; },

    get maxRetries() { return Number(process.env.LLM_MAX_RETRIES) || 3; },
    get cliTimeout() { return Number(process.env.LLM_CLI_TIMEOUT) || 120000; },
    // HTTP request timeout for network LLM providers/embedders (OpenAI,
    // OpenRouter, Voyage). Without it a hung connection blocks the daemon or a
    // hook indefinitely. 60s leaves headroom for large JSON completions while
    // still bounding a dead socket. Local Ollama generation uses cliTimeout
    // (it can legitimately run longer); claude-cli uses cliTimeout too.
    get requestTimeout() { return Number(process.env.LLM_REQUEST_TIMEOUT) || 60000; },
  },

  output: {
    storage: process.env.OUTPUT_STORAGE || 'local',
    dir: process.env.OUTPUT_DIR || './output',
    s3: {
      endpoint: process.env.S3_ENDPOINT || '',
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || 'us-east-1',
      accessKey: process.env.S3_ACCESS_KEY || '',
      secretKey: process.env.S3_SECRET_KEY || '',
      publicUrl: process.env.S3_PUBLIC_URL || '',
    },
  },

  http: {
    enabled: env('SIGIL_HTTP_ENABLED', 'true') !== 'false',
    host: env('SIGIL_HTTP_HOST', '127.0.0.1'),
    port: Number(env('SIGIL_HTTP_PORT', 7777)),
  },

  network: {
    // 'solo'   — no Iroh, single-device install (default).
    // 'master' — owns canonical DB, accepts paired devices.
    // 'follower' — paired with a master, syncs over Iroh.
    // 'lite-follower' — no local DB, every read/write proxied to master.
    mode: env('SIGIL_MODE', 'solo'),
    enabled: env('SIGIL_NETWORK_ENABLED', null) === null
      ? env('SIGIL_MODE', 'solo') !== 'solo'
      : env('SIGIL_NETWORK_ENABLED', 'false') !== 'false',
    masterNodeId: env('SIGIL_MASTER_NODE_ID', '') || null,
  },

  defaults: {
    namespace: process.env.DEFAULT_NAMESPACE || 'default',
  },

  memory: {
    // AUDM dedup: skip if similarity >= this (paraphrase of same fact)
    skipThreshold: Number(process.env.MEMORY_SKIP_THRESHOLD) || 0.88,
    // AUDM dedup: ask LLM if similarity >= this (possibly related).
    // 0.78 floor — measured during eval that 0.65 fired the LLM judge on
    // ~5x as many candidate pairs as actually warranted disambiguation.
    // Cuts ingest LLM cost by ~40% with no measurable quality drop.
    // Override per-deployment via MEMORY_AMBIGUOUS_THRESHOLD.
    ambiguousThreshold: Number(process.env.MEMORY_AMBIGUOUS_THRESHOLD) || 0.78,
    // AUDM supersession scan: when retiring stale facts (UPDATE/CONTRADICT), cast
    // a WIDER net than dedup. A real-world change ("migrated to Postgres") spawns
    // several stale facts phrased about different facets whose embedding
    // similarity to the new fact sits below the 0.78 dedup floor (measured: 0.74–
    // 0.78 for genuine contradictions). The deterministic AUDM judge gates
    // precision, so embedding only needs recall here. Lower than ambiguousThreshold
    // on purpose; raise toward 0.78 to cut ingest LLM cost, lower to catch more
    // facet-shifted contradictions. Override via MEMORY_SUPERSEDE_THRESHOLD.
    supersedeThreshold: Number(process.env.MEMORY_SUPERSEDE_THRESHOLD) || 0.72,
    // Max neighbors examined per new fact during the supersession scan (bounds
    // the worst-case LLM calls per ingested fact).
    supersedeScanLimit: Number(process.env.MEMORY_SUPERSEDE_SCAN_LIMIT) || 8,
    // Search: discard results below this cosine similarity floor
    minFactSimilarity: Number(process.env.MEMORY_MIN_FACT_SIMILARITY) || 0.45,
    // Injection floor (precision-first): for AUTO-injection paths (hooks /
    // hot-context), drop any fact whose absolute cosine similarity to the
    // query is below this. Higher than minFactSimilarity on purpose — when we
    // inject memory unprompted, "empty but honest" beats "full but off-topic"
    // (one irrelevant injection teaches the user to ignore all of them).
    // Explicit human search (CLI/MCP) passes applyFloor:false to bypass.
    // Tune from the Activity log's per-search dropped-count. Cosine, not the
    // normalized rrfScore (which is relative-to-best and always keeps the top
    // result even for an off-topic query).
    injectionFloor: Number(process.env.MEMORY_INJECTION_FLOOR) || 0.6,
  },

  search: {
    // After hybrid retrieval, run an LLM pass over the top-K results to synthesize a coherent
    // answer that cites which items it used. Lifts hit@1 by ~9 points and gives the system a
    // natural way to refuse out-of-corpus queries ("Not in retrieved memory.") instead of
    // producing confidently-wrong answers from tangentially related facts.
    // Trade: +~$0.00015 and +~2.2s per search. Set SIGIL_SYNTHESIZE=false to disable.
    synthesize: env('SIGIL_SYNTHESIZE', 'true') !== 'false',
    // Model for the synthesis pass — defaults to LLM_EXTRACTION_MODEL.
    synthesizeModel: env('SIGIL_SYNTH_MODEL', ''),
  },

  ingest: {
    // false → skip per-chunk fact extraction during ingest (Ogham-style lazy mode).
    // Trades ~17× cheaper writes for ~4 points of hit@1 on narrow queries.
    eagerExtract: env('SIGIL_EAGER_EXTRACT', 'true') !== 'false',
    // Semantic relationship extraction. Entities AND relationships are pulled in
    // ONE fused graph-extraction call (the GraphRAG/LightRAG pattern), then
    // predicates are canonicalized in a local, LLM-free pass. This turns the
    // structurally-present but semantically-empty graph into a real knowledge
    // graph without adding an LLM round-trip over the prior entity-only stage.
    // Set SIGIL_EXTRACT_RELATIONS=false to fall back to entity-only linking.
    extractRelations: env('SIGIL_EXTRACT_RELATIONS', 'true') !== 'false',
    // Gleaning: after the first graph extraction, re-ask the model "what did you
    // miss?" this many times to recover recall a single pass loses (GraphRAG's
    // trick). Defaults OFF: schema-constrained structured output already recovers
    // most of the recall gleaning targeted, and each round is a full extra
    // graph-extraction call — not worth doubling ingest latency by default. Set
    // SIGIL_GRAPH_GLEAN_ROUNDS=1+ to trade latency for recall. Only fires for
    // fact-dense documents (≥5 facts) so short inputs never pay for it.
    graphGleanRounds: Number(env('SIGIL_GRAPH_GLEAN_ROUNDS', 0)),
  },

  hebbian: {
    // Entity-level co-retrieval edges. Sibling of the fact-level signal, but
    // built over entities so it survives paraphrase + AUDM fact splits and
    // sharpens the existing graph traversal in search.
    entity: {
      enabled: env('SIGIL_HEBBIAN_ENTITY_ENABLED', null, 'true') !== 'false',
      // Per-event increment on co-retrieval.
      eta: Number(env('SIGIL_HEBBIAN_ENTITY_ETA', null, 1)),
      // Hard cap on stored strength — prevents hot pairs from dominating.
      cap: Number(env('SIGIL_HEBBIAN_ENTITY_CAP', null, 50)),
      // Lazy exponential decay applied on read.
      halfLifeDays: Number(env('SIGIL_HEBBIAN_ENTITY_HALF_LIFE_DAYS', null, 30)),
      // Minimum decayed strength to surface in getCoRetrievedEntities.
      minEffective: Number(env('SIGIL_HEBBIAN_ENTITY_MIN_EFFECTIVE', null, 0.5)),
      // Blend weight when adding co-retrieval as a third signal in rrfMerge.
      // The boost is normalized to [0,1] across the candidate set, then
      // multiplied by this weight and added to the candidate's RRF score.
      rrfWeight: Number(env('SIGIL_HEBBIAN_ENTITY_RRF_WEIGHT', null, 0.3)),
      // Max entities pulled from the top-K result set for write-side
      // strengthening. O(K²) writes, so kept small.
      maxWriteEntities: Number(env('SIGIL_HEBBIAN_ENTITY_MAX_WRITE', null, 12)),
      // When useGraph is on, pull up to this many co-retrieved neighbors per
      // seed entity to expand the related-fact search.
      expandPerSeed: Number(env('SIGIL_HEBBIAN_ENTITY_EXPAND_PER_SEED', null, 3)),
    },
  },
};

export default config;
