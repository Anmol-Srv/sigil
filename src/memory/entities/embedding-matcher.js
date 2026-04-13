import cortexDb from '../../db/cortex.js';
import { prompt as llmPrompt } from '../../lib/llm.js';
import { pgVector } from '../../lib/vectors.js';
import config from '../../config.js';

const EMBEDDING_THRESHOLD = 0.85;

async function findEmbeddingMatch(name, embedding, { namespace, threshold = EMBEDDING_THRESHOLD, limit = 5 }) {
  if (!embedding) return [];

  const vec = pgVector(embedding);

  const { rows } = await cortexDb.raw(`
    SELECT id, name, entity_type AS "entityType", entity_types AS "entityTypes",
           1 - (embedding <=> ?) AS similarity
    FROM entity
    WHERE namespace = ?
      AND embedding IS NOT NULL
      AND LOWER(name) != LOWER(?)
      AND merged_with IS NULL
      AND 1 - (embedding <=> ?) >= ?
    ORDER BY embedding <=> ?
    LIMIT ?
  `, [vec, namespace, name, vec, threshold, vec, limit]);

  return rows.map((r) => {
    let types;
    try {
      types = r.entityTypes ? JSON.parse(r.entityTypes) : [r.entityType];
    } catch {
      types = [r.entityType];
    }
    return { ...r, types };
  });
}

async function verifyEmbeddingMatch(newName, newType, candidate) {
  const input = `Are these the same real-world entity?

New: "${newName}" (type: ${newType})
Existing: "${candidate.name}" (types: ${candidate.types.join(', ')})

Semantic similarity: ${(candidate.similarity * 100).toFixed(0)}%.
Consider if they refer to the same concept, person, or thing.

Respond with ONLY: yes or no`;

  const response = await llmPrompt(input, { model: config.llm.entityModel, caller: 'entity-matcher' });
  return response.toLowerCase().includes('yes');
}

export { findEmbeddingMatch, verifyEmbeddingMatch };
