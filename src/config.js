const config = {
  db: {
    // 'pglite' (default) — embedded, zero-install. 'postgres' — external Postgres via env vars.
    type: process.env.CORTEX_DB_TYPE || 'pglite',
    host: process.env.CORTEX_DB_HOST || 'localhost',
    port: Number(process.env.CORTEX_DB_PORT) || 5432,
    database: process.env.CORTEX_DB_NAME || 'cortex',
    user: process.env.CORTEX_DB_USER || 'cortex_app',
    password: process.env.CORTEX_DB_PASSWORD || '',
  },

  embedding: {
    provider: process.env.EMBEDDING_PROVIDER || '',
    model: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 768,
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
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

  defaults: {
    namespace: process.env.DEFAULT_NAMESPACE || 'default',
  },

  memory: {
    // AUDM dedup: skip if similarity >= this (paraphrase of same fact)
    skipThreshold: Number(process.env.MEMORY_SKIP_THRESHOLD) || 0.88,
    // AUDM dedup: ask LLM if similarity >= this (possibly related)
    ambiguousThreshold: Number(process.env.MEMORY_AMBIGUOUS_THRESHOLD) || 0.65,
    // Search: discard results below this cosine similarity floor
    minFactSimilarity: Number(process.env.MEMORY_MIN_FACT_SIMILARITY) || 0.45,
  },
};

export default config;
