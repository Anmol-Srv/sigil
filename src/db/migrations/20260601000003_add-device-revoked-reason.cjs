/**
 * Distinguishes "paused" revokes (a key out for service / on a borrowed
 * laptop, expected to come back) from "compromised" revokes (terminal —
 * the keypair leaked and must never authenticate again).
 *
 *   'paused'      → device.activate flips active=true (default)
 *   'compromised' → device.activate refuses; requires re-pairing
 *
 * Nullable so existing rows are unaffected.
 */
exports.up = (knex) =>
  knex.schema.alterTable('device', (t) => {
    t.text('revoked_reason'); // 'paused' | 'compromised' | NULL
  });

exports.down = (knex) =>
  knex.schema.alterTable('device', (t) => {
    t.dropColumn('revoked_reason');
  });
