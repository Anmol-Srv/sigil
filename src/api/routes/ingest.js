import { ingestDocument } from '../../ingestion/pipeline.js';
import { resolveSource } from '../../ingestion/resolve-source.js';
import * as jobs from '../../queue/jobs.js';
import config from '../../config.js';
import { AppError } from '../../lib/errors.js';

const ingestSchema = {
  body: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      filePath: { type: 'string' },
      title: { type: 'string' },
      namespace: { type: 'string' },
      sourceType: { type: 'string' },
      sourcePath: { type: 'string' },
      metadata: { type: 'object' },
      skipFacts: { type: 'boolean', default: false },
      skipEntities: { type: 'boolean', default: false },
      categories: {},
      entities: {},
      // async: true (default) returns jobId immediately; false blocks until done
      async: { type: 'boolean', default: true },
    },
  },
};

const batchSchema = {
  body: {
    type: 'object',
    required: ['documents'],
    properties: {
      documents: {
        type: 'array',
        minItems: 1,
        items: { type: 'object' },
      },
    },
  },
};

async function resolveSourceOrThrow(body) {
  const source = await resolveSource(body);
  if (!source) {
    throw new AppError({ errorCode: 'BAD_REQUEST', message: 'content, url, or filePath required' });
  }
  return source;
}

async function runIngest(body, source) {
  const { title, namespace, sourceType, sourcePath, metadata, skipFacts, skipEntities, categories, entities } = body;
  const ns = namespace || config.defaults.namespace;

  return ingestDocument({
    content: source.content,
    title: title || source.title,
    sourcePath: sourcePath || source.sourcePath,
    sourceType: sourceType || source.sourceType,
    contentType: source.contentType,
    namespace: ns,
    metadata: { ...source.metadata, ...metadata },
    skipFacts,
    skipEntities,
    categories,
    entities,
  });
}

async function handleIngest(request, reply) {
  const source = await resolveSourceOrThrow(request.body);
  const isAsync = request.body.async !== false;

  if (!isAsync) {
    // Synchronous mode — block and return full result (for CLI use, small content)
    const result = await runIngest(request.body, source);
    return result;
  }

  // Async mode — enqueue, return immediately
  const jobId = jobs.create({ body: request.body, source });

  setImmediate(async () => {
    jobs.update(jobId, { status: 'running', startedAt: Date.now() });
    try {
      const result = await runIngest(request.body, source);
      jobs.update(jobId, { status: 'completed', completedAt: Date.now(), result });
    } catch (err) {
      jobs.update(jobId, { status: 'failed', completedAt: Date.now(), error: err.message });
    }
  });

  reply.code(202);
  return { jobId, status: 'queued' };
}

async function handleJobStatus(request) {
  const job = jobs.get(request.params.jobId);
  if (!job) throw new AppError({ errorCode: 'NOT_FOUND', message: `Job ${request.params.jobId} not found` });
  // Don't expose raw payload — just status + result
  const { id, status, createdAt, startedAt, completedAt, result, error } = job;
  return { id, status, createdAt, startedAt, completedAt, result, error };
}

async function handleBatchIngest(request) {
  const { documents } = request.body;

  const results = [];
  for (const doc of documents) {
    try {
      const result = await ingestDocument({
        content: doc.content,
        title: doc.title,
        sourcePath: doc.sourcePath || `batch/${Date.now()}`,
        sourceType: doc.sourceType || 'raw',
        namespace: doc.namespace || config.defaults.namespace,
        metadata: doc.metadata || {},
        skipFacts: doc.skipFacts || false,
        skipEntities: doc.skipEntities || false,
        categories: doc.categories,
        entities: doc.entities,
      });
      results.push({ title: doc.title, status: result.skipped ? 'skipped' : 'ingested', ...result });
    } catch (err) {
      results.push({ title: doc.title, status: 'error', error: err.message });
    }
  }

  return { results };
}

async function ingestRoutes(app) {
  app.post('/api/ingest', { schema: ingestSchema }, handleIngest);
  app.get('/api/ingest/jobs/:jobId', handleJobStatus);
  app.post('/api/ingest/batch', { schema: batchSchema }, handleBatchIngest);
}

export default ingestRoutes;
