/**
 * Allow llm_log.model to be NULL.
 *
 * The column was NOT NULL, which asserted something untrue: for providers that
 * pick their own model (claude-cli, where config.llm.model is null and the CLI
 * chooses), the effective model is only known from a SUCCESSFUL response. On
 * the error path there is no response, so llm.js logs the *configured* model —
 * null — and the insert died with:
 *
 *   null value in column "model" of relation "llm_log" violates not-null
 *
 * The effect was the exact inverse of what the log is for: every successful
 * call was recorded, and every FAILED call — the one you actually need to
 * diagnose a broken provider — was silently dropped, leaving only a rate-limited
 * "[llm-log] write failed" line that named the constraint rather than the outage.
 *
 * NULL now means "unknown model", which is the honest value for a failed call
 * to a CLI-driven provider. The index is unaffected (Postgres indexes NULLs).
 */

exports.up = function (knex) {
  return knex.schema.alterTable('llm_log', (table) => {
    table.text('model').nullable().alter();
  });
};

exports.down = function (knex) {
  // Backfill before restoring the constraint, or the ALTER fails on the very
  // rows this migration made storable.
  return knex('llm_log')
    .whereNull('model')
    .update({ model: 'unknown' })
    .then(() => knex.schema.alterTable('llm_log', (table) => {
      table.text('model').notNullable().alter();
    }));
};
