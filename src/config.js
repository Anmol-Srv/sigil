const env = (key, fallback) => process.env[key] ?? fallback;

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
  db: {
    type: 'postgres',
    // Connection URL takes precedence when set. Recognized providers
    // (Neon, Supabase, RDS, Render, Railway, CockroachDB) get sensible
    // SSL defaults automatically; override with ?sslmode=... in the URL.
    url: env('SIGIL_DATABASE_URL', env('DATABASE_URL', '')) || null,
    host: env('SIGIL_DB_HOST', 'localhost'),
    port: Number(env('SIGIL_DB_PORT', 5432)),
    database: env('SIGIL_DB_NAME', 'sigil'),
    user: env('SIGIL_DB_USER', 'sigil_app'),
    password: env('SIGIL_DB_PASSWORD', ''),
  },

  embedding: {
    provider: process.env.EMBEDDING_PROVIDER || '',
    model: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 768,
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    voyageApiKey: process.env.VOYAGE_API_KEY || '',
    // OpenRouter as an embedding gateway. Models are namespaced (e.g.
    // "openai/text-embedding-3-large", "voyageai/voyage-3-large").
    // Reuses the chat-side referer/title for app attribution.
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterBaseUrl: process.env.EMBEDDING_OPENROUTER_BASE_URL || process.env.LLM_OPENROUTER_BASE_URL || '',
    openrouterReferer: process.env.EMBEDDING_OPENROUTER_REFERER || process.env.LLM_OPENROUTER_REFERER || 'https://github.com/Anmol-Srv/sigil',
    openrouterTitle: process.env.EMBEDDING_OPENROUTER_TITLE || process.env.LLM_OPENROUTER_TITLE || 'Sigil',
  },

  llm: {
    provider: process.env.LLM_PROVIDER || '',

    // OpenAI
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.LLM_OPENAI_MODEL || 'gpt-4o-mini',

    // Ollama
    ollamaHost: process.env.LLM_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434',
    ollamaModel: process.env.LLM_OLLAMA_MODEL || 'qwen2.5:7b',

    // Claude CLI (dev — uses your Claude Code subscription)
    cliModel: process.env.LLM_CLI_MODEL || 'haiku',

    // Anthropic
    apiKey: process.env.ANTHROPIC_API_KEY || '',

    // OpenRouter — OpenAI-compatible gateway; one key, namespaced models
    // like "anthropic/claude-sonnet-latest", "openai/gpt-mini-latest", etc.
    // Default is Gemini Flash latest — best singular all-rounder at current
    // OpenRouter pricing: $0.0005/$0.003 per 1M tokens, 1M context, strong
    // JSON output, ~500ms typical latency. Beats Claude Haiku 2× on cost
    // and 5× on context while matching reasoning + JSON reliability for
    // Sigil's call types (extraction, AUDM, classifier, router, synthesis).
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterModel: process.env.LLM_OPENROUTER_MODEL || 'google/gemini-flash-latest',
    openrouterBaseUrl: process.env.LLM_OPENROUTER_BASE_URL || '',
    openrouterReferer: process.env.LLM_OPENROUTER_REFERER || 'https://github.com/Anmol-Srv/sigil',
    openrouterTitle: process.env.LLM_OPENROUTER_TITLE || 'Sigil',

    // Per-task model overrides (use provider-specific model names)
    extractionModel: process.env.LLM_EXTRACTION_MODEL || '',
    decisionModel: process.env.LLM_DECISION_MODEL || '',
    entityModel: process.env.LLM_ENTITY_MODEL || '',

    maxRetries: Number(process.env.LLM_MAX_RETRIES) || 3,
    cliTimeout: Number(process.env.LLM_CLI_TIMEOUT) || 120000,
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

  server: {
    port: Number(process.env.PORT) || 4000,
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
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
