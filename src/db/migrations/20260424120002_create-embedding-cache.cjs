/**
 * Persistent embedding cache — avoids re-embedding identical text.
 *
 * Keyed on sha256(provider + model + text). Value is the cached vector.
 * LRU eviction when count exceeds a soft limit (applied at write time).
 */

exports.up = async function (knex) {
  await knex.schema.createTable('embedding_cache', (table) => {
    table.string('key').primary();                // sha256(provider|model|text)
    table.string('provider').notNullable();
    table.string('model').notNullable();
    table.integer('hits').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_used_at').notNullable().defaultTo(knex.fn.now());

    table.index('last_used_at');
  });

  // Embedding column with the same dims as everywhere else (768)
  await knex.raw('ALTER TABLE embedding_cache ADD COLUMN embedding vector(768)');
};

exports.down = async function (knex) {
  await knex.schema.dropTable('embedding_cache');
};
