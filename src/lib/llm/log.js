// Shared lightweight LLM helpers.
//
// Sigil deliberately does not persist per-call LLM telemetry. It adds no user
// value to local memory retrieval, can contain sensitive prompts/responses, and
// a CLI/provider probe opening PGlite directly violates the daemon's single
// database-owner rule. Keep only token estimation and bounded transient retry
// behavior required by providers and the embedding boundary.

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function statusFromError(err) {
  if (typeof err?.status === 'number') return err.status;
  const match = /error\s+(\d{3})\b/i.exec(err?.message || '');
  return match ? Number(match[1]) : null;
}

function isRetryable(err) {
  const status = statusFromError(err);
  if (status == null) return true;
  return status === 408 || status === 429 || status >= 500;
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export { estimateTokens, isRetryable, withRetry };
