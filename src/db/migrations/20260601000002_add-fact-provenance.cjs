/**
 * Add cross-device provenance + embedding-shape columns to fact.
 *
 *   embedding_model      — the model that produced this fact's vector.
 *                          Cross-device sync refuses if the master's manifest
 *                          says a different model is in use.
 *   embedding_dim        — dimensionality of the vector. Belt-and-braces
 *                          alongside the model check.
 *   created_by_device_id — which paired device wrote this fact. NULL means
 *                          "the local install" (back-compat with rows that
 *                          existed before this migration).
 *
 * The columns are nullable so the migration is backfill-free; new ingests
 * populate them from the embedder config + the authenticated caller's
 * device row.
 */
exports.up = (knex) =>
  knex.schema.alterTable('fact', (t) => {
    t.text('embedding_model');
    t.integer('embedding_dim');
    t.integer('created_by_device_id').references('device.id').onDelete('SET NULL');
    t.index(['created_by_device_id'], 'idx_fact_by_device');
  });

exports.down = (knex) =>
  knex.schema.alterTable('fact', (t) => {
    t.dropIndex(['created_by_device_id'], 'idx_fact_by_device');
    t.dropColumn('created_by_device_id');
    t.dropColumn('embedding_dim');
    t.dropColumn('embedding_model');
  });
