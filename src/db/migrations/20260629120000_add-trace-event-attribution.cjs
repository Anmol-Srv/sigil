/**
 * Add caller attribution to trace_event.
 *
 *   agent      — which agent originated the traced operation: 'claude-code',
 *                'codex', 'cursor', 'mcp', 'cli', etc. NULL = unknown /
 *                pre-migration. Sourced from the authenticated caller's
 *                request-context (AsyncLocalStorage) via currentAgent().
 *   session_id — the originating session (e.g. a Claude Code session id),
 *                passed explicitly by the caller (the read hook forwards it).
 *                NULL when the caller doesn't carry one (CLI, MCP).
 *
 * This is PROVENANCE for the Activity feed, mirroring fact.created_by_agent
 * (20260601000005). It answers "which session of which agent made this
 * search/expansion call" — previously the trace recorded only device_id +
 * transport, so unprompted hook-driven searches were unattributable.
 */
exports.up = (knex) =>
  knex.schema.alterTable('trace_event', (t) => {
    t.text('agent');
    t.text('session_id');
    t.index(['agent', 'ts'], 'trace_event_agent_ts_idx');
  });

exports.down = (knex) =>
  knex.schema.alterTable('trace_event', (t) => {
    t.dropIndex(['agent', 'ts'], 'trace_event_agent_ts_idx');
    t.dropColumn('agent');
    t.dropColumn('session_id');
  });
