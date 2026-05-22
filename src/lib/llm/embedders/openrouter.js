/**
 * OpenRouter embedder.
 *
 * OpenRouter exposes an OpenAI-compatible `/v1/embeddings` endpoint that
 * routes to upstream vendors. Model names are namespaced like
 * "openai/text-embedding-3-large" or "voyageai/voyage-3-large".
 *
 * The wire shape mirrors OpenAI's, so the body / response parsing is the
 * same as embedders/openai.js — only base URL, auth, and analytics
 * headers differ.
 *
 * The `dimensions` parameter is forwarded for text-embedding-3-* models
 * (Matryoshka truncation). Upstream models that don't support it ignore
 * it, so it's safe to send unconditionally for the openai/* family.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

async function embedBatch(texts, {
  model,
  openrouterApiKey,
  openrouterBaseUrl,
  openrouterReferer,
  openrouterTitle,
  dimensions,
} = {}) {
  if (!openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!model) {
    throw new Error('No OpenRouter embedding model resolved. Set EMBEDDING_MODEL (e.g. "openai/text-embedding-3-large").');
  }

  const body = { model, input: texts };
  // Matryoshka truncation — only the openai/text-embedding-3-* family
  // honors this on OpenRouter, but it's a no-op for the rest.
  if (dimensions && /(^|\/)text-embedding-3/.test(model)) {
    body.dimensions = dimensions;
  }

  const baseUrl = (openrouterBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${openrouterApiKey}`,
  };
  if (openrouterReferer) headers['HTTP-Referer'] = openrouterReferer;
  if (openrouterTitle) headers['X-Title'] = openrouterTitle;

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter embed failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // Defensive sort — OpenAI guarantees input order but some upstreams via
  // OpenRouter have shipped indices out of order.
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

export { embedBatch };
