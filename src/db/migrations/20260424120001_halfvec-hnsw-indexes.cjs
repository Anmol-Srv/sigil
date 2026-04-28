/**
 * Convert HNSW indexes from vector(768) to halfvec(768).
 *
 * The embedding COLUMNS remain vector(768) (float32) — we keep full precision on disk.
 * The INDEX expressions cast to halfvec(768) (float16) which:
 *   - Cuts index size by ~50%
 *   - Slightly faster ANN scans (smaller fetches)
 *   - Negligible quality loss in practice (<1% recall change)
 *
 * Queries must cast to halfvec for index to be used:
 *   ORDER BY embedding::halfvec(768) <=> query::halfvec(768) LIMIT K
 */

exports.up = async function (knex) {
  // Fact
  await knex.raw('DROP INDEX IF EXISTS fact_embedding_idx');
  await knex.raw(`
    CREATE INDEX fact_embedding_idx ON fact
    USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  // Chunk
  await knex.raw('DROP INDEX IF EXISTS chunk_embedding_idx');
  await knex.raw(`
    CREATE INDEX chunk_embedding_idx ON chunk
    USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  // Entity
  await knex.raw('DROP INDEX IF EXISTS entity_embedding_idx');
  await knex.raw(`
    CREATE INDEX entity_embedding_idx ON entity
    USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS fact_embedding_idx');
  await knex.raw('CREATE INDEX fact_embedding_idx ON fact USING hnsw (embedding vector_cosine_ops)');

  await knex.raw('DROP INDEX IF EXISTS chunk_embedding_idx');
  await knex.raw('CREATE INDEX chunk_embedding_idx ON chunk USING hnsw (embedding vector_cosine_ops)');

  await knex.raw('DROP INDEX IF EXISTS entity_embedding_idx');
  await knex.raw('CREATE INDEX entity_embedding_idx ON entity USING hnsw (embedding vector_cosine_ops)');
};
