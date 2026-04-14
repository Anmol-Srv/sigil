exports.up = async function (knex) {
  // Count duplicates before deleting so the operator knows what was removed
  const docDupes = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM document
    WHERE id NOT IN (SELECT MAX(id) FROM document GROUP BY source_path)
  `);
  const docCount = parseInt(docDupes.rows?.[0]?.cnt ?? 0, 10);
  if (docCount > 0) {
    console.warn(`[migration] Removing ${docCount} duplicate document rows (keeping latest per source_path)`);
  }

  await knex.raw(`
    DELETE FROM document
    WHERE id NOT IN (
      SELECT MAX(id) FROM document GROUP BY source_path
    )
  `);

  await knex.schema.alterTable('document', (table) => {
    table.unique('source_path');
  });

  const relDupes = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM relation
    WHERE id NOT IN (
      SELECT MAX(id) FROM relation
      WHERE invalid_at IS NULL
      GROUP BY source_id, target_id, relation_type
    )
  `);
  const relCount = parseInt(relDupes.rows?.[0]?.cnt ?? 0, 10);
  if (relCount > 0) {
    console.warn(`[migration] Removing ${relCount} duplicate relation rows (keeping latest per source/target/type)`);
  }

  await knex.raw(`
    DELETE FROM relation
    WHERE id NOT IN (
      SELECT MAX(id) FROM relation
      WHERE invalid_at IS NULL
      GROUP BY source_id, target_id, relation_type
    )
  `);

  await knex.schema.alterTable('relation', (table) => {
    table.unique(['source_id', 'target_id', 'relation_type']);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('relation', (table) => {
    table.dropUnique(['source_id', 'target_id', 'relation_type']);
  });

  await knex.schema.alterTable('document', (table) => {
    table.dropUnique('source_path');
  });
};
