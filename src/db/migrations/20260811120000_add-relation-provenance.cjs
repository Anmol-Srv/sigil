/**
 * Record HOW a relation was arrived at.
 *
 * Every edge in `relation` looked identical regardless of origin: the table
 * carried mention_count but nothing separating "a model read this off a
 * sentence" from "these two entities keep appearing in the same fact". That was
 * survivable while one LLM pass was the only writer. It stops being survivable
 * the moment a second, cheaper writer exists — derived edges could never be
 * trust-weighted in ranking, re-derived after the algorithm improves, or
 * removed without also deleting asserted ones.
 *
 *   derived_by  'llm-extract'    graph-extractor read it from fact text
 *               'co-occurrence'  derived from fact_entity + named in batch
 *   confidence  'high' | 'medium' | 'low' — the namer's own certainty
 *   weight      the PMI that made the pair a candidate; null for asserted edges
 *
 * Existing rows backfill to 'llm-extract' because that is literally where they
 * came from — graph-extractor was the only writer before this.
 */

exports.up = function (knex) {
  return knex.schema
    .alterTable('relation', (table) => {
      table.text('derived_by').notNullable().defaultTo('llm-extract');
      table.text('confidence');
      table.float('weight');
    })
    .then(() => knex.schema.alterTable('relation', (table) => {
      // Derived edges are queried and pruned as a set, so the discriminator
      // earns an index rather than a sequential scan over every edge.
      table.index('derived_by', 'relation_derived_by_idx');
    }));
};

exports.down = function (knex) {
  return knex.schema.alterTable('relation', (table) => {
    table.dropIndex('derived_by', 'relation_derived_by_idx');
    table.dropColumn('derived_by');
    table.dropColumn('confidence');
    table.dropColumn('weight');
  });
};
