import cortexDb from '../../db/cortex.js';
import { prompt as llmPrompt } from '../../lib/llm.js';
import { pgHalfvecColumn, pgHalfvecParam, pgVector } from '../../lib/vectors.js';
import config from '../../config.js';
import { safeParseEntityTypes } from './store.js';

const EMBEDDING_THRESHOLD = 0.85;

async function findEmbeddingMatch(name, embedding, { namespace, threshold = EMBEDDING_THRESHOLD, limit = 5 }) {
  if (!embedding) return [];

  const vec = pgVector(embedding);
  const embeddingDistance = `${pgHalfvecColumn('embedding')} <=> ${pgHalfvecParam()}`;

  const { rows } = await cortexDb.raw(`
    SELECT id, name, entity_type AS "entityType", entity_types AS "entityTypes",
           1 - (${embeddingDistance}) AS similarity
    FROM entity
    WHERE namespace = ?
      AND embedding IS NOT NULL
      AND LOWER(name) != LOWER(?)
      AND merged_with IS NULL
      AND 1 - (${embeddingDistance}) >= ?
    ORDER BY ${embeddingDistance}
    LIMIT ?
  `, [vec, namespace, name, vec, threshold, vec, limit]);

  return rows.map((r) => ({ ...r, types: safeParseEntityTypes(r) }));
}

// Returns { same: bool, rename: bool, reason: string }.
//   same   — the new mention refers to the same real-world entity as `candidate`
//   rename — same is true AND the new name supersedes the old (push old → aliases)
//
// `episodeText` is the source passage the new entity was extracted from. It
// is the killer feature: it lets the LLM detect rename signals ("X is now
// named Y", "X has been renamed to Y", "we used to call this X") that pure
// name-vector similarity can never see — Smara and Sigil are vector-distant
// strings, but in the rename sentence they're obviously the same entity.
async function verifyEmbeddingMatch(newName, newType, candidate, episodeText) {
  const candidateAliases = (candidate.aliases || []).filter(Boolean);
  const aliasLine = candidateAliases.length
    ? `Existing aliases: ${candidateAliases.join(', ')}`
    : '';
  const similarityLine = candidate.similarity > 0
    ? `Name-embedding similarity: ${(candidate.similarity * 100).toFixed(0)}%`
    : `Name-embedding similarity: not directly measured (LLM judging on episode text alone)`;
  const episodeBlock = episodeText
    ? `\nSource passage where the new mention appeared:\n---\n${episodeText.slice(0, 1500)}\n---\n`
    : '';

  const input = `You're deciding whether two entity mentions refer to the same real-world thing, and whether the source passage indicates a RENAME.

Mention A (new):     "${newName}" (type: ${newType})
Mention B (existing): "${candidate.name}" (types: ${(candidate.types || [candidate.entityType]).join(', ')})
${aliasLine}
${similarityLine}
${episodeBlock}
Decision rules:
- "same" = true when both mentions refer to the same person/product/concept/thing — including renames, abbreviations ("NYC" / "New York City"), and common-knowledge equivalents.
- "rename" = true ONLY when "same" is true AND the source passage says one name has replaced the other ("X is now named Y", "X was renamed to Y", "we renamed X to Y", "X used to be called Y", etc.). A normal synonym match is NOT a rename.
- "current_name" = which of A or B is the new/canonical name per the source passage (the one we want as \`entity.name\` going forward). Only meaningful when "rename" is true. Use the literal string of mention A or B.
- If you cannot tell, "same" is false. Don't guess.

Respond as STRICT JSON, no markdown, no prose:
{"same": boolean, "rename": boolean, "current_name": "<one of A or B verbatim, or null>", "reason": "one short sentence"}`;

  let raw;
  try {
    raw = await llmPrompt(input, { model: config.llm.entityModel, caller: 'entity-matcher' });
  } catch {
    return { same: false, rename: false, reason: 'llm-error' };
  }

  // Lenient JSON parse — the model occasionally wraps in markdown
  const json = extractJson(raw);
  if (json && typeof json.same === 'boolean') {
    return {
      same: json.same === true,
      rename: json.rename === true && json.same === true,
      currentName: typeof json.current_name === 'string' ? json.current_name : null,
      reason: typeof json.reason === 'string' ? json.reason : '',
    };
  }

  // Fallback: if parsing failed, fall back to the prior plain-text behaviour
  return {
    same: /^\s*(yes|true)\b/i.test(raw),
    rename: false,
    currentName: null,
    reason: 'fallback-text-match',
  };
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  return null;
}

export { findEmbeddingMatch, verifyEmbeddingMatch };
