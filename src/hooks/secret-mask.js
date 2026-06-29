/**
 * Secret masking for hook-captured content.
 *
 * Four-layer regex pipeline:
 *   1. KEY=value patterns (service-specific prefixes + generic names)
 *   2. Bare tokens (standalone API keys in text)
 *   3. URL credentials (user:pass@host)
 *   4. Env-var names with values
 *
 * Pure regex, zero LLM cost. Mask preserves the key name so the event is
 * captured ("set API key for Stripe") but never the value.
 */

const MASK = '***MASKED***';

// Layer 1: KEY=value with service-specific prefixes or generic names
const KEY_VALUE_PATTERNS = [
  // OpenAI / Anthropic
  /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,})\b/g,
  // GitHub
  /\b(ghp_[A-Za-z0-9]{36,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(gho_[A-Za-z0-9]{36,})\b/g,
  // GitLab
  /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
  // Slack
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  // Stripe / webhooks
  /\b(whsec_[A-Za-z0-9]{20,})\b/g,
  /\b(rk_(?:live|test)_[A-Za-z0-9]{20,})\b/g,
  // AWS
  /\b(AKIA[A-Z0-9]{16})\b/g,
  /\b(ASIA[A-Z0-9]{16})\b/g,
  // JWT
  /\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  // Discord bot token
  /\b([A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b/g,
  // Telegram bot
  /\b(\d{8,12}:[A-Za-z0-9_-]{35})\b/g,
];

// Layer 2: generic KEY=VALUE or KEY: "VALUE" patterns
const GENERIC_ASSIGNMENT = new RegExp(
  '\\b(api[_-]?key|api[_-]?secret|secret[_-]?key|secret|token|password|passwd|pwd|'
  + 'auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|'
  + 'client[_-]?secret)\\s*[=:]\\s*["\']?([^\\s"\']{8,})["\']?',
  'gi',
);

// Layer 3: URL credentials
const URL_CREDENTIALS = /(\w+:\/\/)([^:/\s]+):([^@\s]{3,})@/g;

// Layer 4: env var names that typically hold connection strings
const ENV_SECRET_KEYS = [
  'DATABASE_URL', 'REDIS_URL', 'MONGODB_URI', 'MONGO_URI', 'POSTGRES_URL',
  'DSN', 'CONNECTION_STRING', 'ENCRYPTION_KEY', 'JWT_SECRET',
  'SIGIL_ENCRYPTION_KEY', 'SESSION_SECRET', 'WEBHOOK_SECRET',
];
const ENV_KEY_PATTERN = new RegExp(
  `\\b(${ENV_SECRET_KEYS.join('|')})\\s*[=:]\\s*["']?([^\\s"']+)["']?`,
  'gi',
);

function maskSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // Layer 1: service-specific token patterns (replace entire token)
  for (const pattern of KEY_VALUE_PATTERNS) {
    out = out.replace(pattern, MASK);
  }

  // Layer 2: generic key=value (preserve key, mask value)
  out = out.replace(GENERIC_ASSIGNMENT, (_, key) => `${key}=${MASK}`);

  // Layer 3: URL credentials
  out = out.replace(URL_CREDENTIALS, (_, proto) => `${proto}${MASK}:${MASK}@`);

  // Layer 4: named env vars
  out = out.replace(ENV_KEY_PATTERN, (_, key) => `${key}=${MASK}`);

  return out;
}

export { maskSecrets, MASK };
