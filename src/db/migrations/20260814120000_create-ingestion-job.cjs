/**
 * Durable ingestion work queue.
 *
 * Document bytes are staged in payload before an async caller receives an ack.
 * The runner leases jobs, so a daemon crash turns an expired `running` row back
 * into queued work instead of silently losing it. Entity and relation work use
 * the same queue and therefore never hold up the searchable fact commit.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('ingestion_job', (t) => {
    t.bigIncrements('id').primary();
    t.text('uid').notNullable().unique();
    t.text('kind').notNullable();
    t.text('status').notNullable().defaultTo('queued');
    t.text('stage').notNullable().defaultTo('queued');
    t.text('namespace');
    t.bigInteger('document_id').references('id').inTable('document').onDelete('SET NULL');
    t.text('dedupe_key');
    t.integer('priority').notNullable().defaultTo(0);
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.jsonb('result');
    t.jsonb('timings').notNullable().defaultTo('{}');
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(3);
    t.timestamp('available_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('lease_owner');
    t.timestamp('lease_expires_at', { useTz: true });
    t.text('error');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('started_at', { useTz: true });
    t.timestamp('completed_at', { useTz: true });
  });

  await knex.schema.alterTable('ingestion_job', (t) => {
    t.index(['status', 'available_at', 'priority'], 'ingestion_job_claim_idx');
    t.index(['namespace', 'created_at'], 'ingestion_job_namespace_idx');
    t.index(['document_id'], 'ingestion_job_document_idx');
  });
  await knex.raw(`
    CREATE UNIQUE INDEX ingestion_job_active_dedupe_idx
    ON ingestion_job (dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
  `);
  await knex.raw(`
    ALTER TABLE ingestion_job
    ADD CONSTRAINT ingestion_job_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed'))
  `);
};

exports.down = (knex) => knex.schema.dropTableIfExists('ingestion_job');
