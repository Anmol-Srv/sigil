import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { promptJson } from '../../lib/llm.js';
import { TtlCache } from '../../lib/cache.js';
import config from '../../config.js';
import { PROMPTS_DIR } from '../../lib/paths.js';

const PROMPT_PATH = join(PROMPTS_DIR, 'query-router.md');

const cache = new TtlCache({ maxSize: 200, ttlMs: 10 * 60 * 1000 });

const VALID_INTENTS = ['preference', 'factual', 'entity_lookup', 'exploratory', 'temporal'];

const INTENT_DEFAULTS = {
  preference: { categories: ['preference', 'opinion', 'personal'], expand: false, useGraph: false, limit: null },
  factual: { categories: [], expand: false, useGraph: false, limit: null },
  entity_lookup: { categories: [], expand: false, useGraph: true, limit: null },
  exploratory: { categories: [], expand: true, useGraph: true, limit: 15 },
  temporal: { categories: [], expand: false, useGraph: false, limit: null },
};

async function routeQuery(query) {
  const cacheKey = query.trim().toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const systemPrompt = await readFile(PROMPT_PATH, 'utf8');

  const input = `${systemPrompt}

---

Query: ${query}

---

Respond with ONLY a JSON object: { "intent": "preference|factual|entity_lookup|exploratory|temporal", "categories": [...], "entities": [...], "expand": bool, "pointInTime": null or "YYYY-MM-DD", "reasoning": "..." }`;

  try {
    const result = await promptJson(input, { model: config.llm.extractionModel, caller: 'query-router' });

    if (!result || !VALID_INTENTS.includes(result.intent)) {
      const fb = buildDecision('factual', {});
      cache.set(cacheKey, fb);
      return fb;
    }

    const defaults = INTENT_DEFAULTS[result.intent];
    const decision = {
      intent: result.intent,
      categories: Array.isArray(result.categories) && result.categories.length ? result.categories : defaults.categories,
      entities: Array.isArray(result.entities) ? result.entities : [],
      expand: typeof result.expand === 'boolean' ? result.expand : defaults.expand,
      useGraph: defaults.useGraph,
      limit: defaults.limit,
      pointInTime: result.pointInTime || null,
      reasoning: result.reasoning || '',
    };

    cache.set(cacheKey, decision);
    return decision;
  } catch (err) {
    console.error('[query-router] Failed:', err.message);
    return buildDecision('factual', { reasoning: `Fallback — ${err.message}` });
  }
}

function buildDecision(intent, overrides = {}) {
  const defaults = INTENT_DEFAULTS[intent];
  return {
    intent,
    categories: defaults.categories,
    entities: [],
    expand: defaults.expand,
    useGraph: defaults.useGraph,
    limit: defaults.limit,
    pointInTime: null,
    reasoning: '',
    ...overrides,
  };
}

export { routeQuery };
