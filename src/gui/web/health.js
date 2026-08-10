/**
 * Turning a `status` payload into what the dashboard says about itself.
 *
 * Pure on purpose: this is the "no soft failures" rule (DESIGN.md principle 1)
 * expressed as data, and getting it wrong is the worst bug the dashboard can
 * have — a dead store rendering as an empty memory. Keeping it out of the DOM
 * code means it can be tested directly.
 */

/**
 * The one thing the user must act on right now, or null when nothing is wrong.
 * Ordered by blast radius: an unreadable store beats a dead embedder beats a
 * dead LLM, because each later failure is survivable while the earlier one is
 * not. Only ever one banner — a stack of warnings is noise, not signal.
 */
export function systemAlert(status = {}) {
  const db = status.db || {};
  const p = status.providers || {};

  if (status.unavailable || db.healthy === false) {
    if (db.schema === 'missing') {
      return {
        level: 'err',
        title: 'Memory store has no schema.',
        body: 'The database is reachable but Sigil’s tables don’t exist yet, so nothing can be stored or recalled.',
        action: { label: 'Run migrations', route: 'setup' },
      };
    }
    return {
      level: 'err',
      title: 'Memory store unreachable.',
      body: db.error || 'Postgres did not answer. Stored facts are intact; nothing can be read or written until it is back.',
      action: { label: 'Check database', route: 'setup' },
    };
  }

  // Embedding before LLM: without vectors, new facts are written but never
  // come back in search — silent data loss from the user's point of view.
  if (p.embedding && p.embedding.ok === false) {
    return {
      level: 'warn',
      title: 'Embedding provider is down.',
      body: `${p.embedding.provider || 'No provider'} — ${p.embedding.error}. New facts can’t be embedded, so they won’t come back in search.`,
      action: { label: 'Change embedding', route: 'settings' },
    };
  }
  if (p.llm && p.llm.ok === false) {
    return {
      level: 'warn',
      title: 'LLM provider is down.',
      body: `${p.llm.provider || 'No provider'} — ${p.llm.error}. Fact extraction and query routing fall back to the simple path.`,
      action: { label: 'Change LLM', route: 'settings' },
    };
  }
  return null;
}

/** One cell of the Home system readout: `{ s: state, v: value, sub?: detail }`. */
export function systemCells(status = {}) {
  const db = status.db || {};
  const p = status.providers || {};
  const q = status.writeQueue;
  return [
    { k: 'Store', ...(status.unavailable || db.healthy === false
      ? { s: 'err', v: db.schema === 'missing' ? 'no schema' : 'unreachable' }
      : { s: 'ok', v: 'connected' }) },
    { k: 'Embedding', ...providerCell(p.embedding) },
    { k: 'LLM', ...providerCell(p.llm) },
    // A non-zero depth is the honest answer to "why is my save slow?"
    { k: 'Write queue', ...(q == null ? { s: '', v: '—' }
      : q === 0 ? { s: 'ok', v: 'idle' }
      : { s: 'warn', v: `${q} waiting`, sub: 'a write is in flight' }) },
  ];
}

function providerCell(h) {
  if (!h) return { s: '', v: 'not probed', sub: 'daemon still starting' };
  if (h.ok) return { s: 'ok', v: h.provider, sub: h.model || undefined };
  return { s: 'err', v: h.provider ? `${h.provider} failing` : 'not configured', sub: h.error || undefined };
}
