/**
 * forgetFact — accept a numeric id, full UID, or UID prefix and delete
 * the matching fact. Returns the deleted content, or `notFound: true`.
 */
export function registerForgetFact(registry) {
  registry.register('forgetFact', async (params) => {
    const { deleteFact } = await import('../../memory/facts/store.js');
    const { default: cortexDb } = await import('../../db/cortex.js');

    const idArg = String(params.id ?? '').trim();
    if (!idArg) {
      const err = new Error('forgetFact: params.id required');
      err.code = 'invalid_params';
      throw err;
    }

    // PR review #8: numeric id or UID prefix; the `fact-` vs bare-prefix
    // branches were doing identical queries.
    const [match] = /^\d+$/.test(idArg)
      ? await cortexDb('fact').where({ id: Number(idArg) }).limit(1)
      : await cortexDb('fact').where('uid', 'like', `${idArg}%`).limit(1);

    if (!match) return { notFound: true, query: idArg };

    const deleted = await deleteFact(match.uid);
    if (!deleted) return { notFound: true, query: idArg };

    return { deleted: { uid: deleted.uid, content: deleted.content } };
  });
}
