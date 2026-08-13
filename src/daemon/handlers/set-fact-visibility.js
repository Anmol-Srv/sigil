/**
 * setFactVisibility — move one fact between the shared pool and a private one.
 *
 * The write path infers visibility from the fact's wording, and inference is
 * wrong sometimes. Without a correction, a misfiled fact is worse than no
 * scoping at all: the user watches a fact vanish from one agent with no way to
 * put it back. This is that way back.
 */
export function registerSetFactVisibility(registry) {
  registry.register('setFactVisibility', async (params) => {
    const { setFactVisibility } = await import('../../memory/facts/store.js');
    return setFactVisibility(params.id, params.visibility);
  });
}
