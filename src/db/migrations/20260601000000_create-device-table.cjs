/**
 * device — devices that have paired with this Sigil cluster.
 *
 * Each row represents a remote Sigil install whose owner has been
 * authorized to read/write this device's memory. `node_id` is the
 * 64-char hex Ed25519 public key (Iroh NodeID + identity, same value).
 *
 * Roles:
 *   reader  — can call read-side RPC methods only
 *   writer  — can also remember/forget/ingest
 *   admin   — can manage other devices (create pairing codes, revoke)
 *
 * `namespaces` scopes what this device can read/write. Empty array means
 * "all namespaces this cluster knows about" (admin default).
 *
 * `active=false` is a soft revoke — preserves history of the device for
 * audit purposes without allowing further calls.
 */
exports.up = (knex) =>
  knex.schema.createTable('device', (t) => {
    t.increments('id').primary();
    t.text('node_id').notNullable().unique();
    t.text('name').notNullable();
    t.text('role').notNullable().defaultTo('writer'); // reader | writer | admin
    t.specificType('namespaces', 'text[]').notNullable().defaultTo('{}');
    t.boolean('active').notNullable().defaultTo(true);
    t.jsonb('meta').notNullable().defaultTo('{}');
    t.timestamp('last_seen_at');
    t.timestamps(false, true);

    t.index(['node_id', 'active'], 'idx_device_lookup');
  });

exports.down = (knex) => knex.schema.dropTable('device');
