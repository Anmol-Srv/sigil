/**
 * Re-score facts that were stamped `vital` by default rather than by judgement.
 *
 * Three code paths defaulted importance UP to 'vital' when the classifier
 * didn't return a usable value: the thought fast-path in ingestion/pipeline.js,
 * the validation fallback in cognitive/input-classifier.js, and the atomic
 * path used when classification failed outright. Measured on a real store,
 * that produced 50 vital facts out of 62.
 *
 * At 81% saturation the flag stops being information. It is read in two places
 * and degrades both:
 *
 *   - the `vital` hot-context kind, which owns always-on slots in every
 *     prompt — so the slots filled with whatever had been ingested most
 *     recently, from any project;
 *   - IMPORTANCE_VITAL_MULT in the search ranking, which multiplies nearly
 *     every row by the same constant and therefore orders nothing.
 *
 * The three defaults are fixed at the source in this same change. This
 * migration repairs the rows already written under them.
 *
 * WHAT IS AND ISN'T RECOVERABLE
 *
 * Nothing distinguishes "the model judged this vital" from "the model said
 * nothing and the code filled in vital" — both wrote the identical string.
 * That information is gone, so this is a heuristic, not a reconstruction.
 *
 * The heuristic: keep vital only where the category is one the user's standing
 * context genuinely depends on (the same set the directive kind selects on),
 * and demote the rest. This errs toward demotion because the two errors are
 * not symmetric — a wrongly-demoted fact is still fully searchable and simply
 * stops occupying a permanent slot, while a wrongly-kept one goes on crowding
 * out the facts that belong there. Re-promote any individual fact by hand if
 * it deserves it.
 *
 * `down` restores vital to exactly the rows this touched, which is why the
 * predicate is repeated rather than blanket-restoring every supplementary row.
 */

// Kept in sync with DIRECTIVE_CATEGORIES in memory/pods/kinds/directive.js.
// Duplicated deliberately: a migration must describe the world as it was when
// it ran, so it cannot import a constant that later changes underneath it.
const KEEP_VITAL = ['preference', 'opinion', 'personal', 'convention'];

exports.up = async (knex) => {
  await knex('fact')
    .where('importance', 'vital')
    .whereNotIn('category', KEEP_VITAL)
    .update({ importance: 'supplementary', importance_score: 2 });
};

exports.down = async (knex) => {
  await knex('fact')
    .where('importance', 'supplementary')
    .whereNotIn('category', KEEP_VITAL)
    .update({ importance: 'vital', importance_score: 5 });
};
