import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { promptJson } from '../../lib/llm.js';
import config from '../../config.js';
import { ALL_CATEGORIES } from '../facts/categories.js';
import { PROMPTS_DIR } from '../../lib/paths.js';

const PROMPT_PATH = join(PROMPTS_DIR, 'input-classifier.md');

const NOISE_MIN_LENGTH = 3;
const DOCUMENT_MIN_LENGTH = 2000;
const VALID_ROUTES = ['thought', 'knowledge', 'noise'];

async function classifyInput(content, { title } = {}) {
  // Heuristic fast-paths — skip LLM for obvious cases
  if (!content?.trim() || content.trim().length < NOISE_MIN_LENGTH) {
    return { route: 'noise', facts: [], entities: [], reasoning: 'Empty or too short' };
  }

  if (content.length > DOCUMENT_MIN_LENGTH) {
    return { route: 'knowledge', facts: [], entities: [], reasoning: 'Long content — auto-routed to full pipeline' };
  }

  // LLM classification for short-to-medium content
  const systemPrompt = await readFile(PROMPT_PATH, 'utf8');

  const input = `${systemPrompt}

---

Title: ${title || '(none)'}
Input: ${content}

---

Respond with ONLY a JSON object: { "route": "thought|knowledge|noise", "facts": [{"content":"...","category":"...","confidence":"high|medium|low","importance":"vital|supplementary"}], "entities": ["..."], "reasoning": "..." }`;

  try {
    const result = await promptJson(input, { model: config.llm.extractionModel, caller: 'classifier' });

    if (!result || !VALID_ROUTES.includes(result.route)) {
      return fallback('Invalid classification result');
    }

    // Validate extracted facts for thought route
    const validCategories = Object.keys(ALL_CATEGORIES);
    const facts = result.route === 'thought' && Array.isArray(result.facts)
      ? result.facts
          .filter((f) => f.content && validCategories.includes(f.category))
          .map((f) => ({
            ...f,
            confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'high',
            importance: ['vital', 'supplementary'].includes(f.importance) ? f.importance : 'vital',
          }))
      : [];

    return {
      route: result.route,
      facts,
      entities: Array.isArray(result.entities) ? result.entities : [],
      reasoning: result.reasoning || '',
    };
  } catch (err) {
    console.error('[input-classifier] Failed:', err.message);
    return fallback(err.message);
  }
}

function fallback(reason) {
  return { route: 'knowledge', facts: [], entities: [], reasoning: `Fallback — ${reason}` };
}

export { classifyInput };
