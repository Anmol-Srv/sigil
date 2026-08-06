/**
 * Store the full original text on the document row.
 *
 * Until now `document` held only metadata (source_path, title, content_hash,
 * counts) and the text lived exclusively in `chunk`. That made "give me this
 * document back, whole" impossible to answer exactly: chunks overlap by ~50
 * tokens (src/ingestion/chunker.js), so concatenating them duplicates text at
 * every seam, and re-reading source_path fails for pasted content and session
 * histories (which get synthetic `raw/<ts>` / `thought:<hash>` paths) or any
 * file that has since moved.
 *
 * Nullable on purpose: documents ingested before this migration have no stored
 * content, and getDocument() falls back to de-overlapped chunk reassembly for
 * them rather than failing. Re-ingesting a document fills the column in.
 */

exports.up = function (knex) {
  return knex.schema.alterTable('document', (table) => {
    table.text('content');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('document', (table) => {
    table.dropColumn('content');
  });
};
