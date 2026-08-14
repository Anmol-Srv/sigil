/** Time spent waiting for a managed worker before model execution began. */
exports.up = (knex) => knex.schema.alterTable('llm_log', (t) => {
  t.integer('queued_ms');
});

exports.down = (knex) => knex.schema.alterTable('llm_log', (t) => {
  t.dropColumn('queued_ms');
});
