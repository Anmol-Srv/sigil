/**
 * Setup step: Your name.
 *
 * "What should we call you?" — stored to config.json AND written as a fact
 * through the full ingest pipeline. That last part is the real point: it
 * exercises the entire stack (LLM classify + chunk + embed + extract + DB
 * write) end to end, so any misconfiguration from the earlier steps surfaces
 * here with an honest error instead of silently breaking later.
 */
import { patchConfig } from '../config-store.js';
import { StepError } from '../errors.js';

export const id = 'identity';
export const title = 'Your name';

export function validate(input = {}) {
  const name = (input.name || '').trim();
  const errors = {};
  if (!name) errors.name = 'tell us what to call you';
  else if (name.length > 80) errors.name = 'that name is too long';
  return { ok: Object.keys(errors).length === 0, errors };
}

export async function apply(input, emit = () => {}) {
  const name = (input.name || '').trim();
  if (!name) throw new StepError({ message: 'A name is required.', kind: 'other' });

  emit({ pct: 15, label: 'Saving your name…' });
  patchConfig('identity', { name });

  emit({ pct: 40, label: 'Writing a first memory (testing the full stack)…' });
  try {
    const { ingestDocument } = await import('../../ingestion/pipeline.js');
    const { default: config } = await import('../../config.js');
    const result = await ingestDocument({
      content: `The user's name is ${name}.`,
      namespace: config.defaults.namespace,
      classify: true,
    });

    const added = (result.facts?.added ?? 0) + (result.facts?.updated ?? 0);
    if (!added && !result.skipped && result.route !== 'noise') {
      // Pipeline ran but stored nothing unexpected — surface it rather than
      // claiming success.
      throw new StepError({ message: 'The memory pipeline ran but stored no fact.', kind: 'other' });
    }

    emit({ pct: 100, label: 'All set.' });
    return { name, factsAdded: added, route: result.route ?? null };
  } catch (err) {
    if (err instanceof StepError) throw err;
    // Any failure here is a real config problem in an earlier step (DB/LLM/
    // embedding). Classify it honestly.
    const { fromError } = await import('../db/shared.js');
    throw fromError(err);
  }
}

export default { id, title, validate, apply };
