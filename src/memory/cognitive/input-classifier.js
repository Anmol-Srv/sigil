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

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.atomic]  The caller asserts this input is ONE short,
 *   self-contained statement — `remember` guarantees it, since it rejects
 *   anything document-shaped up front. Such an input can never need the
 *   knowledge route: chunking a 100-character string yields one chunk,
 *   contextualizing it prefixes a chunk that IS the whole document, and
 *   extraction re-derives the sentence we were handed. That is three LLM calls
 *   (~20s) to get back what the caller already gave us, and it lets the
 *   extractor REWORD a fact the user asked to store verbatim. So a `knowledge`
 *   verdict is coerced to `thought` here. The classifier still runs — splitting
 *   into atomic facts, rejecting noise, and assigning a category are all real
 *   work that only it can do.
 */
async function classifyInput(content, { title, atomic = false } = {}) {
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
      return atomic ? atomicThought(content, 'Invalid classification result') : fallback('Invalid classification result');
    }

    // `knowledge` is not a reachable answer for an input the caller has already
    // guaranteed is one short fact — see the `atomic` note above.
    const route = atomic && result.route === 'knowledge' ? 'thought' : result.route;

    // Validate extracted facts for thought route
    const validCategories = Object.keys(ALL_CATEGORIES);
    const facts = route === 'thought' && Array.isArray(result.facts)
      ? result.facts
          .filter((f) => f.content && validCategories.includes(f.category))
          .map((f) => ({
            ...f,
            confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'high',
            // Unrecognised importance falls back to 'supplementary', not
            // 'vital'. Defaulting UP made vital the value of every fact the
            // model didn't explicitly rate — measured at 50 of 62 on a real
            // store — which drained the word of meaning: 'vital' gates the
            // always-on context block and multiplies the search score, and
            // neither can discriminate when almost everything qualifies.
            importance: ['vital', 'supplementary'].includes(f.importance) ? f.importance : 'supplementary',
          }))
      : [];

    // A coerced `knowledge` verdict carries no facts (the prompt tells it to
    // leave them empty), and a thought route with zero facts stores NOTHING —
    // the input would vanish. Fall back to the caller's own text, which is the
    // fact by construction.
    if (route === 'thought' && !facts.length && atomic) {
      return atomicThought(content, result.reasoning || 'coerced from knowledge');
    }

    return {
      route,
      facts,
      entities: Array.isArray(result.entities) ? result.entities : [],
      reasoning: result.reasoning || '',
    };
  } catch (err) {
    console.error('[input-classifier] Failed:', err.message);
    return atomic ? atomicThought(content, err.message) : fallback(err.message);
  }
}

/** The input, stored verbatim as one fact. Used when the caller guaranteed it. */
function atomicThought(content, reason) {
  return {
    route: 'thought',
    // 'supplementary': this path runs when classification FAILED, so nothing
    // has judged the content. An unjudged fact is the weakest possible claim
    // to a permanent slot in every future prompt.
    facts: [{ content: content.trim(), category: 'domain_knowledge', confidence: 'high', importance: 'supplementary' }],
    entities: [],
    reasoning: `Atomic input — ${reason}`,
  };
}

function fallback(reason) {
  return { route: 'knowledge', facts: [], entities: [], reasoning: `Fallback — ${reason}` };
}

export { classifyInput };
