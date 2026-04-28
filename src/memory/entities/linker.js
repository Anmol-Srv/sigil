import path from 'node:path';

import { resolveEntity, resolveTopicsFromFacts } from './resolver.js';
import { createRelation } from './relations.js';
import { linkEntitiesToFact } from '../facts/entity-linker.js';
import { PROMPTS_DIR } from '../../lib/paths.js';

const ENTITY_PROMPT = path.join(PROMPTS_DIR, 'entity-extraction.md');

/**
 * Orchestrates entity linking for a document ingestion.
 *
 * Supports two modes:
 *   1. Default — creates document entity, optional author, LLM-extracted topics
 *   2. Custom entities — caller provides explicit entities + relations via `entityDefs`
 *
 * entityDefs format:
 *   {
 *     items: [{ name, type, description? }],
 *     relations: [{ source, target, type }]    // source/target are entity names
 *   }
 */
async function linkDocumentEntities(document, factResults, namespace, entityDefs) {
  const { title, sourceType, metadata = {} } = document;

  const activeFacts = factResults.filter((r) => r.action === 'ADD' || r.action === 'UPDATE');
  const factObjects = activeFacts
    .map((r) => r.fact || r.existing)
    .filter(Boolean);

  const firstFact = activeFacts.find((r) => r.fact)?.fact;
  const firstFactId = firstFact?.id || null;
  const today = new Date().toISOString().split('T')[0];

  // Custom entities mode
  if (entityDefs?.items?.length) {
    return linkCustomEntities({
      entityDefs,
      factObjects,
      firstFactId,
      namespace,
      today,
    });
  }

  // Default mode — document + author + LLM-extracted topics
  return linkDefaultEntities({
    title,
    sourceType,
    metadata,
    factObjects,
    firstFactId,
    namespace,
    today,
  });
}

async function linkCustomEntities({ entityDefs, factObjects, firstFactId, namespace, today }) {
  const resolvedByName = {};
  let relationCount = 0;

  // Resolve all declared entities
  for (const item of entityDefs.items) {
    const entity = await resolveEntity({
      name: item.name,
      entityType: item.type,
      description: item.description,
      namespace,
    });
    resolvedByName[item.name] = entity;
  }

  // Create declared relations
  for (const rel of entityDefs.relations || []) {
    const source = resolvedByName[rel.source];
    const target = resolvedByName[rel.target];
    if (!source || !target) continue;

    const relFact = findFactMentioning(factObjects, rel.source) || findFactMentioning(factObjects, rel.target);
    await createRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: rel.type,
      sourceFactId: relFact?.id || firstFactId,
      validAt: today,
    });
    relationCount++;
  }

  // Link facts ↔ entities
  const allEntities = Object.values(resolvedByName);
  let factEntityLinks = 0;

  for (const fact of factObjects) {
    const mentioned = allEntities.filter(
      (e) => fact.content?.toLowerCase().includes(e.name.toLowerCase()),
    );
    if (mentioned.length) {
      await linkEntitiesToFact(fact.id, mentioned);
      factEntityLinks += mentioned.length;
    }
  }

  return {
    entityCount: allEntities.length,
    relationCount,
    factEntityLinks,
    topics: allEntities.filter((e) => e.entityType === 'topic').map((e) => e.name),
  };
}

async function linkDefaultEntities({ title, sourceType, metadata, factObjects, firstFactId, namespace, today }) {
  if (!title) {
    // Thoughts have no title — skip document entity, only resolve topics
    const topics = factObjects.length
      ? await resolveTopicsFromFacts(factObjects, { promptPath: ENTITY_PROMPT, namespace })
      : [];
    return {
      entityCount: topics.length,
      relationCount: 0,
      factEntityLinks: 0,
      topics: topics.map((e) => e.name),
    };
  }

  const docEntity = await resolveEntity({
    name: title,
    entityType: 'document',
    description: `${sourceType} document: ${title}`,
    namespace,
  });

  let authorEntity = null;
  if (metadata.author) {
    authorEntity = await resolveEntity({
      name: metadata.author,
      entityType: 'person',
      namespace,
    });
  }

  const topics = factObjects.length
    ? await resolveTopicsFromFacts(factObjects, { promptPath: ENTITY_PROMPT, namespace })
    : [];

  let relationCount = 0;

  if (authorEntity) {
    await createRelation({
      sourceId: docEntity.id,
      targetId: authorEntity.id,
      relationType: 'AUTHORED_BY',
      sourceFactId: firstFactId,
      validAt: today,
    });
    relationCount++;
  }

  for (const topic of topics) {
    const topicFact = findFactMentioning(factObjects, topic.name);
    await createRelation({
      sourceId: docEntity.id,
      targetId: topic.id,
      relationType: 'COVERS',
      sourceFactId: topicFact?.id || firstFactId,
      validAt: today,
    });
    relationCount++;
  }

  const allEntities = [docEntity, authorEntity, ...topics].filter(Boolean);
  let factEntityLinks = 0;

  for (const fact of factObjects) {
    const mentioned = allEntities.filter(
      (e) => fact.content?.toLowerCase().includes(e.name.toLowerCase()),
    );
    if (mentioned.length) {
      await linkEntitiesToFact(fact.id, mentioned);
      factEntityLinks += mentioned.length;
    }
  }

  return {
    entityCount: allEntities.length,
    relationCount,
    factEntityLinks,
    topics: topics.map((t) => t.name),
  };
}

function findFactMentioning(facts, term) {
  if (!term) return null;
  const lower = term.toLowerCase();
  return facts.find((f) => f.content?.toLowerCase().includes(lower)) || null;
}

export { linkDocumentEntities };
