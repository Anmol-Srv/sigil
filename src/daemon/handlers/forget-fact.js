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

    let match;
    if (/^\d+$/.test(idArg)) {
      [match] = await cortexDb('fact').where({ id: Number(idArg) }).limit(1);
    } else if (idArg.startsWith('fact-')) {
      [match] = await cortexDb('fact').where('uid', 'like', `${idArg}%`).limit(1);
    } else {
      [match] = await cortexDb('fact').where('uid', 'like', `${idArg}%`).limit(1);
    }

    if (!match) return { notFound: true, query: idArg };

    const deleted = await deleteFact(match.uid);
    if (!deleted) return { notFound: true, query: idArg };

    return { deleted: { uid: deleted.uid, content: deleted.content } };
  });
}
