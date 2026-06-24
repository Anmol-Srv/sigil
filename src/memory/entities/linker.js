import { resolveEntity } from './resolver.js';
import { createRelation } from './relations.js';
import { extractAndResolveGraph } from './graph-extractor.js';
import { linkEntitiesToFact } from '../facts/entity-linker.js';
import { escapeRegex } from '../../lib/text.js';
import cortexDb from '../../db/cortex.js';

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

  const episodeText = factObjects.map((f) => f.content).filter(Boolean).join('\n');

  // Resolve all declared entities; thread the cohort so each resolveEntity
  // can consider previously-resolved entities as Stage 3 candidates.
  const cohort = [];
  for (const item of entityDefs.items) {
    const entity = await resolveEntity({
      name: item.name,
      entityType: item.type,
      description: item.description,
      namespace,
      episodeText,
      episodeEntityIds: cohort,
    });
    resolvedByName[item.name] = entity;
    if (entity?.id) cohort.push(entity.id);
  }

  // Create declared relations
  for (const rel of entityDefs.relations || []) {
    const source = resolvedByName[rel.source];
    const target = resolvedByName[rel.target];
    if (!source || !target) continue;

    const relFact = findFactMentioning(factObjects, rel.source) || findFactMentioning(factObjects, rel.target);
    relationCount += await safeCreateRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: rel.type,
      sourceFactId: relFact?.id || firstFactId,
      validAt: today,
    });
  }

  // Widen with any pod-backed entities (person pods) the facts also mention,
  // even if the caller didn't declare them in entityDefs.
  const podEntities = await findMentionedPodEntities(factObjects, namespace);
  const allEntities = mergeUniqueById(Object.values(resolvedByName), podEntities);
  let factEntityLinks = 0;

  for (const fact of factObjects) {
    const mentioned = allEntities.filter((e) => factMentionsEntity(fact.content, e));
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
    // Thoughts have no title — skip the document entity creation, but
    // still resolve topics AND link them to the underlying facts so that
    // search-time graph traversal can find a thought via its topic
    // entity. (Earlier behaviour returned early without linking, leaving
    // every thought-route fact orphaned in fact_entity. Renames in
    // particular relied on these links being present so that the renamed
    // entity's UUID still points at the historical text.)
    const graph = factObjects.length
      ? await extractAndResolveGraph(factObjects, { namespace, today })
      : { entities: [], relationCount: 0 };
    const topics = graph.entities;

    const podEntities = await findMentionedPodEntities(factObjects, namespace);
    const allEntities = mergeUniqueById(topics, podEntities);

    let factEntityLinks = 0;
    for (const fact of factObjects) {
      const mentioned = allEntities.filter((e) => factMentionsEntity(fact.content, e));
      if (mentioned.length) {
        await linkEntitiesToFact(fact.id, mentioned);
        factEntityLinks += mentioned.length;
      }
    }

    return {
      entityCount: allEntities.length,
      relationCount: graph.relationCount,
      factEntityLinks,
      topics: topics.map((e) => e.name),
    };
  }

  const docEpisodeText = factObjects.map((f) => f.content).filter(Boolean).join('\n').slice(0, 2000);

  const docEntity = await resolveEntity({
    name: title,
    entityType: 'document',
    description: `${sourceType} document: ${title}`,
    namespace,
    episodeText: docEpisodeText,
  });

  let authorEntity = null;
  if (metadata.author) {
    authorEntity = await resolveEntity({
      name: metadata.author,
      entityType: 'person',
      namespace,
      episodeText: docEpisodeText,
      episodeEntityIds: docEntity?.id ? [docEntity.id] : [],
    });
  }

  const graph = factObjects.length
    ? await extractAndResolveGraph(factObjects, { namespace, today })
    : { entities: [], relationCount: 0 };
  const topics = graph.entities;

  let relationCount = graph.relationCount;

  if (authorEntity) {
    relationCount += await safeCreateRelation({
      sourceId: docEntity.id,
      targetId: authorEntity.id,
      relationType: 'AUTHORED_BY',
      sourceFactId: firstFactId,
      validAt: today,
    });
  }

  for (const topic of topics) {
    const topicFact = findFactMentioning(factObjects, topic.name);
    relationCount += await safeCreateRelation({
      sourceId: docEntity.id,
      targetId: topic.id,
      relationType: 'COVERS',
      sourceFactId: topicFact?.id || firstFactId,
      validAt: today,
    });
  }

  const declaredEntities = [docEntity, authorEntity, ...topics].filter(Boolean);
  const podEntities = await findMentionedPodEntities(factObjects, namespace);
  const allEntities = mergeUniqueById(declaredEntities, podEntities);
  let factEntityLinks = 0;

  for (const fact of factObjects) {
    const mentioned = allEntities.filter((e) => factMentionsEntity(fact.content, e));
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

// Best-effort relation insert. A structural edge that fails (e.g. a transient
// FK race when a concurrent ingest merges one of the endpoint entities) must
// not abort the rest of the linking — graph enrichment is additive. Returns 1
// on success, 0 on failure, so callers can accumulate the count.
async function safeCreateRelation(spec) {
  try {
    await createRelation(spec);
    return 1;
  } catch (err) {
    console.error(`[linker] relation failed (${spec.relationType}): ${err.message}`);
    return 0;
  }
}

function findFactMentioning(facts, term) {
  if (!term) return null;
  const lower = term.toLowerCase();
  return facts.find((f) => f.content?.toLowerCase().includes(lower)) || null;
}

// True if a fact's text mentions an entity by its canonical name OR by any
// stored alias. Word-boundary check on the fact text — using includes() would
// give false positives ("Sigil" matching "Sigilum"). Aliases are already
// lowercased in storage; the canonical name is lowercased here.
function factMentionsEntity(content, entity) {
  if (!content || !entity?.name) return false;
  const text = content.toLowerCase();
  const candidates = [entity.name.toLowerCase(), ...(entity.aliases || [])];
  return candidates.some((c) => {
    if (!c) return false;
    const re = new RegExp(`\\b${escapeRegex(c)}\\b`);
    return re.test(text);
  });
}

function mergeUniqueById(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const e of list) {
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

// Pull pod-backed entities (today: person pods) in the namespace and return
// the ones whose canonical name or any alias appears in at least one fact in
// this batch. Used to widen the entity set so a document that mentions
// "Maya Iyer" gets its facts linked to her canonical entity even when the
// document has no author frontmatter and topic extraction missed her.
async function findMentionedPodEntities(factObjects, namespace) {
  if (!factObjects?.length) return [];

  const rows = await cortexDb('entity as e')
    .join('pod as p', 'p.entity_id', 'e.id')
    .where('p.status', 'active')
    .where('e.namespace', namespace)
    .whereNull('e.mergedWith')
    .select('e.id', 'e.uid', 'e.name', 'e.entityType', 'e.aliases');

  if (!rows.length) return [];

  return rows.filter((entity) =>
    factObjects.some((f) => factMentionsEntity(f.content, entity)),
  );
}

export { linkDocumentEntities };
