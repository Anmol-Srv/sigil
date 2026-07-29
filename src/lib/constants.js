/**
 * Build-time invariants. These are intentionally NOT user-configurable — they
 * are baked into the database schema AND the embedding contract so the two can
 * never drift apart (the dimension-mismatch trap that fails ingest/search with
 * "db not supporting / model not supporting").
 */

// Every embedding Sigil stores is exactly this many dimensions. The DB's
// vector(N) columns and every embedding provider/model are pinned to it; a
// model that can't natively emit — or truncate (Matryoshka) to — this size is
// rejected at setup rather than failing later. Changing this is a schema
// break, not a config tweak.
export const EMBEDDING_DIM = 1024;

// Explicit `remember` is for compact, atomic statements. Large text belongs in
// document ingestion, where it is chunked before embedding.
export const MAX_FACTS_PER_REQUEST = 100;
export const MAX_ATOMIC_FACT_CHARS = 4_000;
export const MAX_NAMESPACE_CHARS = 128;
