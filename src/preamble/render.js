/**
 * Render a PreambleResult into agent-consumable text.
 *
 * Three formats:
 *   - 'md'    (default) — status lines + a `## Sigil memory` block + a
 *              transport-tailored "how to use" footer + health warnings.
 *              This is what the `prime` tool returns and what the CLI prints.
 *   - 'lines' — just the `KEY: value` status lines (gstack-style), for a bash
 *              preamble that wants to branch on them.
 *   - 'json'  — the raw structured result, for programmatic callers/hooks.
 *
 * The `transport` flag tailors the footer: 'mcp' clients (Codex/Cursor) have
 * NO hooks, so they're told to call `search`/`ingest` themselves; 'hooks'
 * clients (Claude Code) are reminded the work is automatic.
 */

/**
 * @param {import('./run.js').PreambleResult} r
 * @param {{format?:'md'|'lines'|'json', transport?:'mcp'|'hooks'|'cli'}} [opts]
 */
export function renderPreamble(r, { format = 'md', transport = 'cli' } = {}) {
  if (format === 'json') return JSON.stringify(r, null, 2);
  if (format === 'lines') return statusLines(r).join('\n');

  const out = [...statusLines(r), ''];

  if (r.facts.length) {
    out.push(`## Sigil memory (${r.facts.length} facts loaded at session start)`);
    for (const f of r.facts) out.push(`- ${f.content}`);
  } else if (r.state === 'degraded') {
    out.push('## Sigil memory');
    out.push('- (unavailable — see the health warnings below)');
  } else {
    out.push('## Sigil memory');
    out.push('- (nothing stored yet — facts accrue as you and the user work)');
  }

  out.push('', usageFooter(transport));

  if (r.issues.length) {
    out.push('', '## Sigil health');
    for (const i of r.issues) out.push(`- ⚠ ${i}`);
  }

  return out.join('\n');
}

/** Format a check as `detail` (ok), `down (detail)` (configured but failing),
 *  or `not configured` (no provider). Error details are kept to one short line. */
function fmtCheck(c) {
  if (!c) return 'unknown';
  if (c.ok) return c.detail || 'ok';
  if (!c.detail || c.detail === 'not configured') return 'not configured';
  const oneLine = String(c.detail).split('\n')[0].slice(0, 80);
  return `down (${oneLine})`;
}

/** The gstack-style `KEY: value` status lines an agent (or shell) branches on. */
export function statusLines(r) {
  const lines = [`SIGIL: ${r.state}`];
  if (r.checks.daemon) lines.push(`DAEMON: ${r.checks.daemon.ok ? 'up' : `down (${r.checks.daemon.detail || 'unreachable'})`}`);
  if (r.checks.db) lines.push(`DB: ${r.checks.db.ok ? `ok${r.checks.db.detail ? ` (${r.checks.db.detail})` : ''}` : `down (${r.checks.db.detail || 'unreachable'})`}`);
  lines.push(`LLM: ${fmtCheck(r.checks.llm)}`);
  lines.push(`EMBED: ${fmtCheck(r.checks.embedding)}`);
  lines.push(`FACTS: ${r.facts.length} loaded / ${r.totals?.facts ?? 0} total`);
  return lines;
}

function usageFooter(transport) {
  if (transport === 'mcp') {
    return [
      '## Using Sigil (no automatic memory in this client)',
      '- Nothing is injected or saved automatically here. Call the `search` tool BEFORE answering anything that depends on the user, their preferences, or this project; call `ingest` to save durable facts the user will want next session.',
      '- When you use a stored fact, name it in one short clause so the user sees their context being applied.',
    ].join('\n');
  }
  if (transport === 'session-hooks') {
    // Cursor: hooks load memory at session start and save each turn, but its
    // prompt hook can't add context, so per-prompt recall is a tool call.
    return [
      '## Using Sigil',
      '- Memory above was loaded at session start, and each turn is saved automatically. Nothing is added per prompt here: call the `search` tool BEFORE answering anything that depends on the user, their preferences, or this project.',
      '- When you use a stored fact, name it in one short clause so the user sees their context being applied.',
    ].join('\n');
  }
  // Claude Code / hooks-capable: the hooks already inject + save.
  return [
    '## Using Sigil',
    '- Memory is auto-injected per prompt and saved by hooks. Read the injected facts first; use `search` only to drill down when the injection missed something.',
  ].join('\n');
}
