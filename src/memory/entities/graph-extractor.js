import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { promptJson } from '../../lib/llm.js';
import config from '../../config.js';
import { PROMPTS_DIR } from '../../lib/paths.js';
import { escapeRegex } from '../../lib/text.js';
import { resolveEntity, resolveEntityList } from './resolver.js';
import { createRelation } from './relations.js';

const GRAPH_PROMPT = path.join(PROMPTS_DIR, 'graph-extraction.md');
const GLEAN_MIN_FACTS = 5;

// Schema-constrained output shape (OpenAI/OpenRouter json_schema). Forces the
// model to return exactly { entities:[{name,description}], relationships:[
// {subject,relationship,object}] } — eliminating the mis-shaped-JSON failures
// that free-form json_object mode lets through on small models. strict mode
// requires every property listed in `required` and additionalProperties:false.
const GRAPH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, description: { type: 'string' } },
        required: ['name', 'description'],
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string' },
          relationship: { type: 'string' },
          object: { type: 'string' },
        },
        required: ['subject', 'relationship', 'object'],
      },
    },
  },
  required: ['entities', 'relationships'],
};

// Canonicalization (the EDC "canonicalize" phase) — a local, LLM-free pass that
// collapses the natural-language predicates a model emits onto a compact set of
// stable relation_type codes, so the graph doesn't fragment into
// "uses"/"utilizes"/"is built with" variants of one edge. Unmatched predicates
// fall back to a deterministic UPPER_SNAKE normalization so novel relations
// still land — just un-canonicalized.
const RELATION_SYNONYMS = [
  [/^(renamed from|was renamed from|formerly|previously named|previously called|used to be called)$/, 'RENAMED_FROM'],
  [/^(renamed to|renamed as|now named|now called|is now)$/, 'RENAMED_TO'],
  [/^(works on|working on|builds|building|develops|developing|maintainer of|maintains|contributor to)$/, 'WORKS_ON'],
  [/^(works at|employed by|member of|part of the team at)$/, 'WORKS_AT'],
  [/^(created by|authored by|written by|made by|developed by)$/, 'CREATED_BY'],
  [/^(uses|using|used|utilizes|built with|built on|powered by|runs on)$/, 'USES'],
  [/^(depends on|requires|needs|relies on)$/, 'DEPENDS_ON'],
  [/^(part of|belongs to|component of|subsystem of|module of|contained in)$/, 'PART_OF'],
  [/^(located in|based in|lives in|situated in)$/, 'LOCATED_IN'],
  [/^(type of|kind of|instance of|is a|is an|subclass of)$/, 'IS_A'],
  [/^(replaces|supersedes|deprecates|succeeds)$/, 'REPLACES'],
  [/^(integrates with|connects to|talks to|communicates with|interfaces with)$/, 'INTEGRATES_WITH'],
  [/^(related to|associated with|linked to|connected with)$/, 'RELATED_TO'],
  [/^(stores|stored in|persists to|saves to|writes to)$/, 'STORES_IN'],
];

function canonicalizeRelationType(rawPredicate) {
  if (!rawPredicate || typeof rawPredicate !== 'string') return null;
  const norm = rawPredicate.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return null;

  for (const [pattern, code] of RELATION_SYNONYMS) {
    if (pattern.test(norm)) return code;
  }

  const fallback = norm.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (!fallback || fallback.length > 40) return null;
  return fallback;
}

// Word-boundary check so "sigil" doesn't match "sigilum".
function textMentions(content, name) {
  if (!content || !name) return false;
  return new RegExp(`\\b${escapeRegex(name.toLowerCase())}\\b`).test(content.toLowerCase());
}

function parseGraph(parsed) {
  if (!parsed || typeof parsed !== 'object') return { entities: [], relationships: [] };
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const relationships = Array.isArray(parsed.relationships) ? parsed.relationships : [];
  return { entities, relationships };
}

function normalizeEntities(raw) {
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, description: typeof e.description === 'string' ? e.description : null });
  }
  return out;
}

function normalizeRelationships(raw) {
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const subject = typeof t?.subject === 'string' ? t.subject.trim() : '';
    const relationship = typeof t?.relationship === 'string' ? t.relationship.trim() : '';
    const object = typeof t?.object === 'string' ? t.object.trim() : '';
    if (!subject || !relationship || !object) continue;
    if (subject.toLowerCase() === object.toLowerCase()) continue;
    const key = `${subject.toLowerCase()}|${relationship.toLowerCase()}|${object.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject, relationship, object });
  }
  return out;
}

// One fused LLM call → { entities, relationships }, plus optional gleaning
// rounds that re-ask the model for anything it missed (GraphRAG's recall trick).
// Gleaning only fires for fact-dense docs so short thought-route inputs don't
// pay for a second call.
async function extractGraph(factObjects) {
  const factsText = factObjects.map((f) => `- ${f.content}`).filter(Boolean).join('\n');
  if (!factsText) return { entities: [], relationships: [] };

  const systemPrompt = await readFile(GRAPH_PROMPT, 'utf8');
  const basePrompt = `${systemPrompt}\n\n---\n\n**Facts:**\n${factsText}`;

  const first = parseGraph(await promptJson(basePrompt, { model: config.llm.entityModel, caller: 'graph-extractor', schema: GRAPH_SCHEMA }));
  let entities = normalizeEntities(first.entities);
  let relationships = normalizeRelationships(first.relationships);

  const rounds = factObjects.length >= GLEAN_MIN_FACTS ? Math.max(0, config.ingest.graphGleanRounds) : 0;
  for (let r = 0; r < rounds; r++) {
    const already = JSON.stringify({
      entities: entities.map((e) => e.name),
      relationships: relationships.map((t) => `${t.subject} ${t.relationship} ${t.object}`),
    });
    const gleanPrompt = `${basePrompt}

---

You already extracted this graph:
${already}

Review the facts again and output ONLY the entities and relationships you MISSED — same JSON object format ({ "entities": [...], "relationships": [...] }). If you missed nothing, return { "entities": [], "relationships": [] }. Do not repeat anything above.`;

    let more;
    try {
      more = parseGraph(await promptJson(gleanPrompt, { model: config.llm.entityModel, caller: 'graph-extractor-glean', schema: GRAPH_SCHEMA }));
    } catch {
      break;
    }
    const newEntities = normalizeEntities([...entities, ...more.entities]);
    const newRels = normalizeRelationships([...relationships, ...more.relationships]);
    const grew = newEntities.length > entities.length || newRels.length > relationships.length;
    entities = newEntities;
    relationships = newRels;
    if (!grew) break; // dry round — stop early
  }

  return { entities, relationships };
}

/**
 * Fused graph extraction: in ONE LLM call (plus optional gleaning) pull the
 * entities AND relationships a document's facts assert, resolve the entities to
 * canonical nodes, then write typed, canonicalized, provenance-linked edges into
 * the `relation` table. Replaces the former two-call (entity-then-triple) path.
 *
 * Relationship endpoints bind to the just-resolved entity cohort first (no
 * re-resolution); a name not in the cohort creates a new node only when it
 * appears verbatim in a fact (grounded) and looks like a real entity — so a weak
 * model can't flood the graph with junk, but edges like (user)-WORKS_ON->(sigil)
 * still form when one endpoint is new.
 *
 * @returns {Promise<{ entities: object[], relationCount: number }>}
 */
async function extractAndResolveGraph(factObjects, { namespace, today }) {
  if (!factObjects?.length) return { entities: [], relationCount: 0 };

  let graph;
  try {
    graph = await extractGraph(factObjects);
  } catch (err) {
    console.error(`[graph-extractor] extraction failed: ${err.message}`);
    return { entities: [], relationCount: 0 };
  }

  const episodeText = factObjects.map((f) => f.content).filter(Boolean).join('\n');

  // Resolve the extracted entities (two-pass rename-aware) into canonical nodes.
  const entities = await resolveEntityList(graph.entities, { namespace, episodeText });

  if (!config.ingest.extractRelations || !graph.relationships.length) {
    return { entities, relationCount: 0 };
  }

  // Build a lowercase name/alias → entity lookup over the resolved cohort.
  const byName = new Map();
  const cohortIds = [];
  for (const e of entities) {
    if (!e?.id) continue;
    cohortIds.push(e.id);
    if (e.name) byName.set(e.name.toLowerCase(), e);
    for (const a of e.aliases || []) {
      if (a) byName.set(a.toLowerCase(), e);
    }
  }

  // Cohort hit → reuse. Miss → create only if grounded in fact text. New nodes
  // join the cohort so later relationships in the same document reuse them.
  const resolveEndpoint = async (name) => {
    const key = name.toLowerCase();
    const hit = byName.get(key);
    if (hit) return hit;

    const grounded = factObjects.some((f) => textMentions(f.content, name));
    if (!grounded || name.length < 2 || name.length > 60) return null;

    const entity = await resolveEntity({
      name,
      entityType: 'topic',
      namespace,
      episodeText,
      episodeEntityIds: cohortIds,
    });
    if (!entity?.id) return null;

    byName.set(key, entity);
    if (entity.name) byName.set(entity.name.toLowerCase(), entity);
    cohortIds.push(entity.id);
    return entity;
  };

  let relationCount = 0;
  for (const t of graph.relationships) {
    const relationType = canonicalizeRelationType(t.relationship);
    if (!relationType) continue;

    const source = await resolveEndpoint(t.subject);
    const target = await resolveEndpoint(t.object);
    if (!source || !target || source.id === target.id) continue;

    const sourceFact = factObjects.find(
      (f) => textMentions(f.content, source.name) || textMentions(f.content, target.name),
    );

    try {
      await createRelation({
        sourceId: source.id,
        targetId: target.id,
        relationType,
        sourceFactId: sourceFact?.id || null,
        validAt: today,
      });
      relationCount++;
    } catch (err) {
      console.error(`[graph-extractor] relation failed (${source.name} ${relationType} ${target.name}): ${err.message}`);
    }
  }

  return { entities, relationCount };
}

export { extractAndResolveGraph, canonicalizeRelationType };
