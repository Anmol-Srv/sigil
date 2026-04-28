import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { promptJson } from '../lib/llm.js';
import config from '../config.js';
import { PROMPTS_DIR } from '../lib/paths.js';

const PROMPT_PATH = join(PROMPTS_DIR, 'chunk-context.md');

async function contextualizeChunks(chunks, documentText, { title }) {
  if (!chunks.length) return chunks;

  const systemPrompt = await readFile(PROMPT_PATH, 'utf8');

  const excerpts = chunks.map((c, i) => `Chunk ${i + 1}: ${c.content.slice(0, 200)}`);

  const fullPrompt = `${systemPrompt}

---

**Document title:** ${title}

**Full document:**
${documentText.slice(0, 8000)}

**Chunks (${chunks.length}):**
${excerpts.join('\n')}

---

Respond with a JSON array of ${chunks.length} context prefix strings.`;

  try {
    const prefixes = await promptJson(fullPrompt, { model: config.llm.extractionModel, caller: 'contextualizer' });

    // Model sometimes wraps the array in an object — unwrap any single array value
    const resolvedPrefixes = Array.isArray(prefixes)
      ? prefixes
      : prefixes && typeof prefixes === 'object'
        ? Object.values(prefixes).find((v) => Array.isArray(v)) ?? null
        : null;

    if (!resolvedPrefixes) {
      console.warn('[contextualizer] LLM did not return an array — skipping');
      return chunks;
    }

    const prefixList = resolvedPrefixes;

    if (prefixList.length !== chunks.length) {
      console.warn(`[contextualizer] Got ${prefixList.length} prefixes for ${chunks.length} chunks — using partial`);
    }

    return chunks.map((chunk, i) => ({
      ...chunk,
      contextualPrefix: typeof prefixList[i] === 'string' ? prefixList[i] : null,
    }));
  } catch (err) {
    console.error('[contextualizer] Failed:', err.message);
    return chunks;
  }
}

export { contextualizeChunks };
