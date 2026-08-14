import { getJob } from '../../ingestion/jobs/store.js';

export function registerIngestionJobs(registry) {
  registry.register('ingestionJob.get', async (params = {}) => {
    if (!params.uid) {
      const err = new Error('ingestionJob.get: uid is required');
      err.code = 'invalid_params';
      throw err;
    }
    const job = await getJob(params.uid);
    if (!job) return null;
    // Never echo staged source bytes over a status RPC. Callers need lifecycle,
    // timing, result and error only.
    const { payload: _payload, ...safe } = job;
    return safe;
  });
}
