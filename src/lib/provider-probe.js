/**
 * Live provider health probe — turns "configured?" into "actually works?".
 *
 * The daemon already probes the DB at boot, but a valid-looking-but-dead
 * provider (revoked key, unreachable Ollama, wrong model) stayed invisible
 * until the first real ingest/hook failed. This probes the LLM and embedder
 * with a tiny live call when the user explicitly runs `sigil doctor`.
 *
 * NEVER throws — mirrors the preamble's contract. Every path returns a
 * structured `{ ok, provider, model, error }` so callers can render status.
 *
 * Cost: one tiny optional-LLM completion + one cache-bypassed embed. Never run
 * at daemon boot, during recall, or during status polling.
 */
import config from '../config.js';
import { EMBEDDING_DIM } from './constants.js';

export async function probeProviders({ llm = true, embed = true } = {}) {
  const result = { checkedAt: Date.now() };
  // Run both concurrently — they hit different services.
  const [embedding, llmHealth] = await Promise.all([
    embed ? probeEmbedding() : Promise.resolve(null),
    llm ? probeLlm() : Promise.resolve(null),
  ]);
  if (embed) result.embedding = embedding;
  if (llm) result.llm = llmHealth;
  return result;
}

async function probeEmbedding() {
  const provider = config.embedding.provider || null;
  const model = config.embedding.model || null;
  if (!provider) return { ok: false, provider: null, model: null, dim: EMBEDDING_DIM, error: 'not configured' };
  try {
    const { embed: embedOne } = await import('../ingestion/embedder.js');
    // cache:false — probe the provider, don't touch the Postgres embed cache.
    const v = await embedOne('Sigil provider health probe', { cache: false });
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      return { ok: false, provider, model, dim: Array.isArray(v) ? v.length : null, error: `returned ${Array.isArray(v) ? `${v.length}-dim` : 'no'} vector, expected ${EMBEDDING_DIM}` };
    }
    return { ok: true, provider, model, dim: v.length, error: null };
  } catch (err) {
    return { ok: false, provider, model, dim: null, error: err.message };
  }
}

async function probeLlm() {
  const provider = config.llm.provider || null;
  // The configured LLM model varies by provider; read the stored value.
  let model = null;
  try {
    const { getConfig } = await import('../setup/config-store.js');
    model = getConfig()?.llm?.model || null;
  } catch { /* fall through */ }

  if (!provider) return { ok: false, provider: null, model: null, error: 'not configured' };
  try {
    const { prompt } = await import('./llm.js');
    const res = await prompt('Reply with the single word: ok', { caller: 'provider-probe' });
    if (typeof res !== 'string' || !res.trim()) {
      return { ok: false, provider, model, error: 'empty response from provider' };
    }
    return { ok: true, provider, model, error: null };
  } catch (err) {
    return { ok: false, provider, model, error: err.message };
  }
}
