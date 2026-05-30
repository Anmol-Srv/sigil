/**
 * Add `created_by_agent` provenance to fact.
 *
 *   created_by_agent — which agent wrote this fact: 'claude-code', 'codex',
 *                       'cursor', 'mcp', 'cli', etc. NULL means unknown /
 *                       pre-migration (back-compat).
 *
 * This is PROVENANCE, not SCOPE: it is recorded, surfaced, and filterable,
 * but never a default retrieval partition. Cross-agent sharing is the product
 * — Claude must still see what Cursor wrote — so agent never enters the
 * default WHERE clause. Nullable = backfill-free; new ingests populate it from
 * the authenticated caller's request-context (AsyncLocalStorage). Mirrors the
 * created_by_device_id column added in 20260601000002.
 */
exports.up = (knex) =>
  knex.schema.alterTable('fact', (t) => {
    t.text('created_by_agent');
    t.index(['created_by_agent'], 'idx_fact_by_agent');
  });

exports.down = (knex) =>
  knex.schema.alterTable('fact', (t) => {
    t.dropIndex(['created_by_agent'], 'idx_fact_by_agent');
    t.dropColumn('created_by_agent');
  });
