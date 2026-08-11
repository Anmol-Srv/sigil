/**
 * Add `visibility` to fact — which principals may retrieve it.
 *
 * Sigil already records WHO wrote a fact (created_by_device_id,
 * created_by_agent) and has always treated that as provenance only, never as a
 * retrieval scope. That default is right and stays: cross-agent sharing is the
 * product. Claude must see what Cursor wrote, and the cloud agent's notes on a
 * bug are worthless if the laptop can't read them.
 *
 * But a small class of facts is genuinely addressed TO one assistant rather
 * than being true of the user's world. "Call me sir", "always answer in
 * bullets", "you are my pair-programmer" — told to one agent, these describe a
 * relationship with that agent, and replaying them into a different agent puts
 * words in its mouth the user never asked for. Provenance cannot express this,
 * because provenance is never filtered on.
 *
 * Values (one column; the principal is implied by the value):
 *
 *   'shared'  DEFAULT — every device and every agent of this owner. The
 *             overwhelming majority of facts. Matches what every surveyed
 *             sync system does at the product layer: sync everything, and
 *             carve out narrow, deliberate exceptions.
 *   'agent'   only the agent that wrote it (matched on created_by_agent).
 *             The "call me sir" class.
 *   'device'  only the install that wrote it (matched on created_by_device_id).
 *             Machine-local truth: a checkout path, a local port, a GPU.
 *
 * Why a column and not derived from pod membership: the hook dispatcher makes
 * the PROJECT pod own every hook write, so an agent-directed instruction typed
 * inside a repo lands in a pod whose kind is `shared`. The pod says what the
 * fact is ABOUT; it cannot say who it is FOR.
 *
 * NOT NULL with a default, so the migration is backfill-free and every
 * pre-existing fact keeps its current, fully-visible behaviour. Changing a
 * fact's visibility later is supported and takes effect on the next read —
 * there is no cached copy on another device to chase, because in a shared
 * database there is only ever one row.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable('fact', (t) => {
    t.text('visibility').notNullable().defaultTo('shared');
  });

  // Reads filter on visibility on EVERY query, and the overwhelmingly common
  // value is 'shared'. A partial index over just the exceptions keeps the
  // index tiny (a few rows out of the whole store) while still letting the
  // planner find them; the 'shared' majority is served by the existing
  // namespace/status indexes without this one bloating them.
  await knex.raw(`
    CREATE INDEX idx_fact_visibility_scoped
    ON fact (visibility, created_by_agent, created_by_device_id)
    WHERE visibility <> 'shared'
  `);

  await knex.raw(`
    ALTER TABLE fact ADD CONSTRAINT fact_visibility_check
    CHECK (visibility IN ('shared', 'agent', 'device'))
  `);
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE fact DROP CONSTRAINT IF EXISTS fact_visibility_check');
  await knex.raw('DROP INDEX IF EXISTS idx_fact_visibility_scoped');
  await knex.schema.alterTable('fact', (t) => {
    t.dropColumn('visibility');
  });
};
