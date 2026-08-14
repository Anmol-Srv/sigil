/**
 * Cheap exact-content revalidation at commit time.
 *
 * Fact preparation deliberately runs outside the write transaction. Two
 * concurrent callers can therefore prepare the same new fact before either
 * commits. The apply phase probes md5(content)+namespace under the serialized
 * commit lock; this partial expression index keeps that guard O(log n) without
 * trying to btree-index arbitrarily long fact text.
 */
exports.up = (knex) => knex.raw(`
  CREATE INDEX fact_active_content_hash_idx
  ON fact (namespace, md5(content))
  WHERE status = 'active'
`);

exports.down = (knex) => knex.raw('DROP INDEX IF EXISTS fact_active_content_hash_idx');
