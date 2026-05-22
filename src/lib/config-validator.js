/**
 * Sigil config validator — catches the family of bugs that produced the
 * 161 silent hook failures over 7 days (e.g., EMBEDDING_PROVIDER=voyage
 * + EMBEDDING_MODEL=nomic-embed-text). Detects misconfigurations at
 * startup so hooks fail loud and `sigil doctor` shows a fix command.
 *
 * Returns array of issues:
 *   [{ level: 'fail' | 'warn', code: string, message: string, fix: string }]
 *
 * Empty array = config is healthy.
 *
 * Called by:
 *   - sigil doctor (surfaces inline with fix commands as `fail` entries)
 *   - each hook at startup (any fail-level issue → log + skip the LLM
 *     call, don't blow up — the hook still returns successfully so it
 *     doesn't block Claude Code, but it logs to .hook-errors.log)
 *
 * Two variants:
 *   - validateConfig()      synchronous, regex-only checks
 *   - validateConfigDeep()  async, also tries Postgres connect
 */

import config from '../config.js';

// Heuristic: which model names look like they belong to which provider.
// Not exhaustive — meant to catch the obviously-wrong combinations
// (e.g., Ollama model name sent to a cloud provider) rather than
// authoritative validation.
const EMBEDDING_MODEL_PATTERNS = {
  voyage: [/^voyage-/],
  openai: [/^text-embedding-/],
  ollama: [
    /^nomic-embed/,
    /^mxbai-embed/,
    /^all-minilm/,
    /^bge-/,
    /^snowflake-/,
    /^granite-embedding/,
  ],
};

const LLM_KEY_BY_PROVIDER = {
  openai: 'openaiApiKey',
  anthropic: 'apiKey',
  openrouter: 'openrouterApiKey',
};

const EMBEDDING_KEY_BY_PROVIDER = {
  openai: 'openaiApiKey',
  voyage: 'voyageApiKey',
  openrouter: 'openrouterApiKey',
  // ollama doesn't need a key
};

export function validateConfig() {
  const issues = [];

  validateEmbedding(issues);
  validateLlm(issues);
  validateDb(issues);

  return issues;
}

export async function validateConfigDeep() {
  const issues = validateConfig();

  if (config.db.type === 'postgres' && !issues.some((i) => i.code.startsWith('DB_'))) {
    try {
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.raw('SELECT 1');
    } catch (err) {
      issues.push({
        level: 'fail',
        code: 'DB_UNREACHABLE',
        message: `Postgres at ${config.db.host}:${config.db.port}/${config.db.database} unreachable: ${err.message.split('\n')[0]}`,
        fix: 'Start Postgres (e.g. `docker start sigil-pg` or your equivalent) and verify SIGIL_DB_HOST/PORT/NAME/USER/PASSWORD in ~/.sigil/.env',
      });
    }
  }

  return issues;
}

function validateEmbedding(issues) {
  const { provider, model } = config.embedding;

  // Provider/model mismatch — the bug class that caused 161 silent
  // failures over the last 7 days. Only fires when the model *clearly
  // belongs to a different provider*; unknown/custom model names pass
  // through (we don't pretend to know every model on every provider).
  if (provider && model) {
    const actualProvider = Object.keys(EMBEDDING_MODEL_PATTERNS).find(
      (p) => EMBEDDING_MODEL_PATTERNS[p].some((re) => re.test(model)),
    );
    if (actualProvider && actualProvider !== provider) {
      issues.push({
        level: 'fail',
        code: 'EMBEDDING_PROVIDER_MODEL_MISMATCH',
        message: `EMBEDDING_PROVIDER=${provider} but EMBEDDING_MODEL=${model} is a ${actualProvider} model.`,
        fix: suggestEmbeddingFix(provider, model, actualProvider),
      });
    }
  }

  // Provider needs a key (except ollama which is local)
  if (provider && EMBEDDING_KEY_BY_PROVIDER[provider]) {
    const keyField = EMBEDDING_KEY_BY_PROVIDER[provider];
    if (!config.embedding[keyField]) {
      issues.push({
        level: 'fail',
        code: 'EMBEDDING_PROVIDER_MISSING_KEY',
        message: `EMBEDDING_PROVIDER=${provider} but no ${envNameFor(keyField)} found.`,
        fix: `Set ${envNameFor(keyField)} in ~/.sigil/.env, or run 'sigil init' to reconfigure.`,
      });
    }
  }
}

function validateLlm(issues) {
  const { provider } = config.llm;

  // Provider needs a key (ollama / claude-cli are key-less)
  if (provider && LLM_KEY_BY_PROVIDER[provider]) {
    const keyField = LLM_KEY_BY_PROVIDER[provider];
    if (!config.llm[keyField]) {
      issues.push({
        level: 'fail',
        code: 'LLM_PROVIDER_MISSING_KEY',
        message: `LLM_PROVIDER=${provider} but no ${envNameFor(keyField)} found.`,
        fix: `Set ${envNameFor(keyField)} in ~/.sigil/.env, or run 'sigil init' to reconfigure.`,
      });
    }
  }

  // OpenRouter model format: must include a slash (vendor/model)
  if (provider === 'openrouter' && config.llm.openrouterModel) {
    if (!config.llm.openrouterModel.includes('/')) {
      issues.push({
        level: 'warn',
        code: 'OPENROUTER_MODEL_FORMAT',
        message: `LLM_OPENROUTER_MODEL=${config.llm.openrouterModel} doesn't look like vendor/model format.`,
        fix: 'Use format like "anthropic/claude-haiku-4-5" or "google/gemini-2.5-flash".',
      });
    }
  }
}

function validateDb(issues) {
  if (config.db.type === 'postgres') {
    if (!config.db.host || !config.db.database || !config.db.user) {
      issues.push({
        level: 'fail',
        code: 'DB_CONFIG_INCOMPLETE',
        message: 'SIGIL_DB_TYPE=postgres but host/database/user missing.',
        fix: 'Set SIGIL_DB_HOST, SIGIL_DB_NAME, SIGIL_DB_USER, SIGIL_DB_PASSWORD in ~/.sigil/.env. Run `sigil init` for an interactive setup.',
      });
    }
  }
}

function envNameFor(configField) {
  // Map config.embedding.openaiApiKey → OPENAI_API_KEY, etc.
  return ({
    openaiApiKey: 'OPENAI_API_KEY',
    apiKey: 'ANTHROPIC_API_KEY',
    openrouterApiKey: 'OPENROUTER_API_KEY',
    voyageApiKey: 'VOYAGE_API_KEY',
  })[configField] || configField;
}

function suggestEmbeddingFix(provider, model, actualProvider) {
  const examples = {
    voyage: 'voyage-3.5, voyage-3-large, voyage-code-3.5',
    openai: 'text-embedding-3-large, text-embedding-3-small',
    ollama: 'nomic-embed-text, mxbai-embed-large',
  }[provider] || '(see provider docs)';

  return `Either set EMBEDDING_PROVIDER=${actualProvider} (matches your current model), or change EMBEDDING_MODEL to one of: ${examples}`;
}
