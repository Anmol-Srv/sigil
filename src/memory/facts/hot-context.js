/**
 * Hot context — surfaces the most relevant facts for automatic injection
 * into every new Claude session via ~/.claude/CLAUDE.md.
 *
 * Facts are scored by: importance × access frequency × recency.
 * The result is a short snapshot (≤ CONTEXT_LIMIT facts) that Claude
 * reads at session start without needing an explicit search.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import cortexDb from '../../db/cortex.js';
import config from '../../config.js';

const CONTEXT_LIMIT = 20;

/**
 * Returns the top N fact strings scored by relevance to an active session.
 * Two passes:
 *  1. vital facts ordered by access count (things marked important that keep coming up)
 *  2. recently touched facts regardless of importance (recent work context)
 * Results are merged and deduplicated.
 */
export async function getHotFacts({ namespace, limit = CONTEXT_LIMIT } = {}) {
  const ns = namespace || config.defaults.namespace;
  const half = Math.ceil(limit / 2);

  const [vital, recent] = await Promise.all([
    cortexDb('fact as f')
      .leftJoin('fact_lifecycle as fl', 'fl.fact_id', 'f.id')
      .where({ 'f.status': 'active', 'f.namespace': ns, 'f.importance': 'vital' })
      .orderByRaw('COALESCE(fl.access_count, 0) DESC, f.created_at DESC')
      .limit(half)
      .pluck('f.content'),

    cortexDb('fact as f')
      .leftJoin('fact_lifecycle as fl', 'fl.fact_id', 'f.id')
      .where({ 'f.status': 'active', 'f.namespace': ns })
      .orderByRaw('COALESCE(fl.last_accessed_at, f.created_at) DESC')
      .limit(limit)
      .pluck('f.content'),
  ]);

  const seen = new Set();
  return [...vital, ...recent]
    .filter((c) => {
      if (!c || seen.has(c)) return false;
      seen.add(c);
      return true;
    })
    .slice(0, limit);
}

/**
 * Regenerates the <!-- cortex-context --> block in ~/.claude/CLAUDE.md.
 * Safe to call after every remember/ingest — fast DB read + file write.
 */
export async function updateContextSnapshot({ namespace, limit } = {}) {
  const fs = await import('node:fs/promises');
  // Cortex owns ~/.cortex/CLAUDE.md entirely — never touches ~/.claude/CLAUDE.md
  const cortexMdPath = join(homedir(), '.cortex', 'CLAUDE.md');

  const facts = await getHotFacts({ namespace, limit });
  const marker = '<!-- cortex-context -->';

  if (!facts.length) return 0;

  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = [
    marker,
    `## Active Context  *(${facts.length} facts · refreshed ${date})*`,
    '',
    facts.map((f) => `- ${f}`).join('\n'),
    marker,
  ].join('\n');

  let existing = '';
  try { existing = await fs.readFile(cortexMdPath, 'utf8'); } catch { /* file may not exist */ }

  const updated = existing.includes(marker)
    ? existing.replace(new RegExp(`${marker}[\\s\\S]*?${marker}`), block)
    : existing + (existing.trim() ? '\n\n' : '') + block + '\n';

  await fs.writeFile(cortexMdPath, updated, 'utf8');

  return facts.length;
}
