/**
 * Split volatile lifecycle state (access_count, last_accessed_at) off the fact row
 * into a dedicated fact_lifecycle table.
 *
 * Reason: Postgres HNSW indexes cannot do HOT updates. When a column on a row with
 * an HNSW index is UPDATEd — even a column unrelated to the embedding — Postgres
 * creates a new tuple and rewrites the index entry. At high search volume, this
 * causes catastrophic HNSW index bloat and autovacuum pressure.
 *
 * Fix: keep the fact row read-mostly. Lifecycle state (access_count, last_accessed_at)
 * lives in fact_lifecycle with a FK and a trigger for auto-insert on new facts.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('fact_lifecycle', (table) => {
    table.bigInteger('fact_id').primary().references('id').inTable('fact').onDelete('CASCADE');
    table.integer('access_count').notNullable().defaultTo(0);
    table.timestamp('last_accessed_at');
    table.string('stage').notNullable().defaultTo('fresh'); // fresh | stable | editing
    table.timestamp('stage_entered_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('last_accessed_at');
    table.index(['stage', 'stage_entered_at']);
  });

  // Backfill existing facts into fact_lifecycle
  await knex.raw(`
    INSERT INTO fact_lifecycle (fact_id, access_count, last_accessed_at, stage, stage_entered_at, created_at)
    SELECT
      id,
      COALESCE(access_count, 0),
      last_accessed_at,
      'stable' AS stage,
      COALESCE(created_at, NOW()) AS stage_entered_at,
      COALESCE(created_at, NOW()) AS created_at
    FROM fact
    ON CONFLICT (fact_id) DO NOTHING
  `);

  // Trigger to auto-insert a lifecycle row when a new fact is inserted.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION fact_init_lifecycle() RETURNS trigger AS $$
    BEGIN
      INSERT INTO fact_lifecycle (fact_id, access_count, last_accessed_at, stage, stage_entered_at, created_at)
      VALUES (NEW.id, 0, NULL, 'fresh', NOW(), NOW())
      ON CONFLICT (fact_id) DO NOTHING;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS fact_init_lifecycle_trigger ON fact;
    CREATE TRIGGER fact_init_lifecycle_trigger
      AFTER INSERT ON fact
      FOR EACH ROW EXECUTE FUNCTION fact_init_lifecycle();
  `);

  // Drop the old columns from fact — these have moved to fact_lifecycle.
  await knex.schema.alterTable('fact', (table) => {
    table.dropColumn('access_count');
    table.dropColumn('last_accessed_at');
  });
};

exports.down = async function (knex) {
  // Re-add columns to fact
  await knex.schema.alterTable('fact', (table) => {
    table.integer('access_count').defaultTo(0);
    table.timestamp('last_accessed_at');
  });

  // Copy data back
  await knex.raw(`
    UPDATE fact f
    SET access_count = fl.access_count,
        last_accessed_at = fl.last_accessed_at
    FROM fact_lifecycle fl
    WHERE f.id = fl.fact_id
  `);

  await knex.raw('DROP TRIGGER IF EXISTS fact_init_lifecycle_trigger ON fact');
  await knex.raw('DROP FUNCTION IF EXISTS fact_init_lifecycle()');
  await knex.schema.dropTable('fact_lifecycle');
};
