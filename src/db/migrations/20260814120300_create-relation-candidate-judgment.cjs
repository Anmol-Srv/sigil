/**
 * Remember negative relation judgments at the evidence version that produced
 * them. A rejected co-occurrence pair is reconsidered only after its shared
 * active-fact count grows, preventing every ingest from paying to reject the
 * same pair again while still allowing new evidence to change the verdict.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('relation_candidate_judgment', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('source_id').notNullable().references('id').inTable('entity').onDelete('CASCADE');
    t.bigInteger('target_id').notNullable().references('id').inTable('entity').onDelete('CASCADE');
    t.integer('shared_facts').notNullable();
    t.text('decision').notNullable().defaultTo('rejected');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['source_id', 'target_id'], { indexName: 'relation_candidate_judgment_pair_uniq' });
  });
  await knex.raw(`
    ALTER TABLE relation_candidate_judgment
    ADD CONSTRAINT relation_candidate_judgment_order_check CHECK (source_id < target_id),
    ADD CONSTRAINT relation_candidate_judgment_decision_check CHECK (decision IN ('rejected'))
  `);
};

exports.down = (knex) => knex.schema.dropTableIfExists('relation_candidate_judgment');
