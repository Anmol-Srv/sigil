/**
 * pairing_code — one-shot, time-limited tokens that authorize a new
 * device to register itself.
 *
 * The plaintext code is shown to the operator (printed by `sigil pair
 * create`); only its SHA-256 hash is stored. Joining device presents
 * the plaintext during the pairing handshake.
 *
 * `consumed_by_device_id` is set once the code is redeemed; thereafter
 * the row is kept for audit but cannot be redeemed again.
 */
exports.up = (knex) =>
  knex.schema.createTable('pairing_code', (t) => {
    t.increments('id').primary();
    t.text('code_hash').notNullable().unique();
    t.text('name').notNullable();                     // intended device name, e.g. "laptop-b"
    t.text('role').notNullable().defaultTo('writer'); // role to assign on redemption
    t.specificType('namespaces', 'text[]').notNullable().defaultTo('{}');
    t.timestamp('expires_at').notNullable();
    t.integer('consumed_by_device_id').references('device.id').onDelete('SET NULL');
    t.timestamp('consumed_at');
    t.timestamps(false, true);

    t.index(['expires_at'], 'idx_pairing_code_expiry');
  });

exports.down = (knex) => knex.schema.dropTable('pairing_code');
