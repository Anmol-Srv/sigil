/**
 * Add `created_by_origin` ownership identity to fact (P7).
 *
 *   created_by_origin — a STABLE per-install/per-owner identity stamped on
 *   every write: the paired RPC device id (as text) when present, otherwise
 *   the local install id from config.json (`device.id`, a UUID). TEXT, so it
 *   holds either form without the integer-FK constraints of
 *   `created_by_device_id`.
 *
 * Why this exists: P2 owner-scoping keyed visibility off `created_by_device_id`,
 * an INTEGER FK to the `device` table that is only populated for *paired*
 * devices. Local CLI/hook writes stamp it NULL, and NULL rows are always
 * visible — so two PEOPLE sharing one DB+namespace via local installs saw each
 * other's `private`/`session` facts. `created_by_origin` is always stamped
 * (local or paired), so owner-scoping can isolate private memory per person.
 *
 * Back-compat: pre-P7 rows have created_by_origin IS NULL and stay globally
 * visible (treated as legacy, exactly like the NULL-device rule). No backfill.
 */
exports.up = (knex) =>
  knex.schema.alterTable('fact', (t) => {
    t.text('created_by_origin');
    t.index(['created_by_origin'], 'idx_fact_by_origin');
  });

exports.down = (knex) =>
  knex.schema.alterTable('fact', (t) => {
    t.dropIndex(['created_by_origin'], 'idx_fact_by_origin');
    t.dropColumn('created_by_origin');
  });
