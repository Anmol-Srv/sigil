import { readFile } from 'node:fs/promises';
import { chunk as batchChunk } from 'lodash-es';

import { promptJson } from '../../lib/llm.js';
import config from '../../config.js';

const CONCURRENCY = 5;

function buildChunkText(chunk) {
  const parts = [];
  if (chunk.sectionHeading) parts.push(`[Section: ${chunk.sectionHeading}]`);
  if (chunk.contextualPrefix) parts.push(chunk.contextualPrefix);
  parts.push(chunk.content);
  return parts.join('\n');
}

function buildPrompt(systemPrompt, text, categories) {
  return `${systemPrompt}

---

${text}

---

Respond with ONLY a JSON array of facts. Each fact object must have exactly these fields:
- "content" (string): the atomic fact statement
- "category" (string): one of ${categories.join(', ')}
- "confidence" (string): one of high, medium, low
- "importance" (string): "vital" if essential to understanding the topic, "supplementary" if supporting detail

Output the JSON array directly, no explanation or wrapping.`;
}

function validateFacts(parsed, categories) {
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.facts) ? parsed.facts : null;
  if (!arr) return [];
  return arr
    .filter((f) => f.content && categories.includes(f.category) && ['high', 'medium', 'low'].includes(f.confidence))
    .map((f) => ({
      ...f,
      importance: ['vital', 'supplementary'].includes(f.importance) ? f.importance : 'supplementary',
    }));
}

async function extractFactsFromChunk(chunk, systemPrompt, categories) {
  const text = buildChunkText(chunk);
  const fullPrompt = buildPrompt(systemPrompt, text, categories);

  // temperature: 0 — fact extraction must be reproducible. Non-deterministic
  // phrasing of the same fact shifts its embedding and defeats deterministic
  // duplicate suppression on repeated extraction.
  const parsed = await promptJson(fullPrompt, { model: config.llm.extractionModel, caller: 'extractor', temperature: 0 });
  const facts = validateFacts(parsed, categories);

  return facts.map((f) => ({ ...f, sourceSection: chunk.sectionHeading || null }));
}

/**
 * Extract facts from each chunk independently, in parallel batches.
 * Uses section heading + contextual prefix for richer per-chunk context.
 */
async function extractFactsFromChunks(chunks, { promptPath, categories }) {
  if (!chunks.length) return [];

  const systemPrompt = await readFile(promptPath, 'utf8');
  const batches = batchChunk(chunks, CONCURRENCY);
  const allFacts = [];

  for (const batch of batches) {
    const results = await Promise.all(
      batch.map((c) => extractFactsFromChunk(c, systemPrompt, categories).catch((err) => {
        console.error(`[extractor] chunk failed: ${err.message}`);
        return [];
      })),
    );
    allFacts.push(...results.flat());
  }

  return allFacts;
}

export { extractFactsFromChunks };
