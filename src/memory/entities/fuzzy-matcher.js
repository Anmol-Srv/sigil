import cortexDb from '../../db/cortex.js';
import { prompt as llmPrompt } from '../../lib/llm.js';
import config from '../../config.js';

const FUZZY_THRESHOLD = 0.85;

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]);
      }
    }
  }
  return dp[m][n];
}

function stringSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

async function findFuzzyMatch(name, { namespace, limit = 5 }) {
  const candidates = await cortexDb('entity')
    .where({ namespace })
    .whereNull('mergedWith')
    .select('id', 'name', 'entityType', 'entityTypes')
    .limit(200);

  return candidates
    .map((c) => {
      let types;
      try {
        types = c.entityTypes ? JSON.parse(c.entityTypes) : [c.entityType];
      } catch {
        types = [c.entityType];
      }
      return { ...c, similarity: stringSimilarity(name, c.name), types };
    })
    .filter((c) => c.similarity >= FUZZY_THRESHOLD && c.name.toLowerCase() !== name.toLowerCase())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

async function verifyFuzzyMatch(newName, newType, candidate) {
  const input = `Are these the same real-world entity?

New: "${newName}" (type: ${newType})
Existing: "${candidate.name}" (types: ${candidate.types.join(', ')})

String similarity: ${(candidate.similarity * 100).toFixed(0)}%.
Consider abbreviations, nicknames, and variations.

Respond with ONLY: yes or no`;

  const response = await llmPrompt(input, { model: config.llm.entityModel });
  return response.toLowerCase().includes('yes');
}

export { findFuzzyMatch, verifyFuzzyMatch, stringSimilarity };
