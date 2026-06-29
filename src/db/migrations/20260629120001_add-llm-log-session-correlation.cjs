/**
 * Add managed-session correlation to llm_log.
 *
 *   worker_id    — the warm worker that served this call (e.g. 'claude-0',
 *                  whose tmux session is 'sigil-claude-0'). NULL for one-shot
 *                  (claude -p) and API-provider calls.
 *   req_id       — the reqId correlating an llm_log row to a managed-session
 *                  dispatch/result event in trace_event (kind='engine').
 *   via_fallback — true when the managed-session engine bailed to the one-shot
 *                  claude-cli path (no workers, dead-man timeout, boot circuit
 *                  breaker). Lets you see warm-path hit rate at a glance.
 *
 * Before this, llm_log carried only `caller` (functional role) — there was no
 * way to attribute a call to a specific warm worker or know whether it took
 * the warm path. `caller` already exists from 20260405140000.
 */
exports.up = (knex) =>
  knex.schema.alterTable('llm_log', (t) => {
    t.text('worker_id');
    t.text('req_id');
    t.boolean('via_fallback');
  });

exports.down = (knex) =>
  knex.schema.alterTable('llm_log', (t) => {
    t.dropColumn('worker_id');
    t.dropColumn('req_id');
    t.dropColumn('via_fallback');
  });
