/**
 * trace_event — persisted, queryable causal log of what the daemon did.
 *
 * Each row is one top-level operation (a search, an ingest/remember, a
 * lifecycle sweep). `detail` (jsonb) holds the full structured trace:
 * for search — the routing decision, matched entity, and every ranked
 * fact with its similarity / RRF / ACT-R activation (decay) / final
 * score; for ingest — classify → chunk → extract → per-fact AUDM verdict
 * (with the similarity that drove it) → entity links.
 *
 * The live activity feed still streams over the event bus; this table is
 * the durable history the GUI's Activity tab reads + filters.
 */
exports.up = async (knex) => {
  await knex.schema.createTable('trace_event', (t) => {
    t.bigIncrements('id').primary();
    t.text('uid').notNullable().unique();         // trace-<nanoid>
    t.text('kind').notNullable();                 // 'search' | 'ingest' | 'lifecycle' | ...
    t.timestamp('ts', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.integer('duration_ms');
    t.text('namespace');
    t.text('summary');                            // one-line human description
    t.text('device_id');                          // provenance (null = this device)
    t.text('transport');                          // cli | mcp | gui | iroh | null
    t.jsonb('detail').notNullable().defaultTo('{}');
  });

  // Hot path is "latest N, optionally filtered by kind".
  await knex.schema.alterTable('trace_event', (t) => {
    t.index(['ts'], 'trace_event_ts_idx');
    t.index(['kind', 'ts'], 'trace_event_kind_ts_idx');
  });
};

exports.down = (knex) => knex.schema.dropTableIfExists('trace_event');
