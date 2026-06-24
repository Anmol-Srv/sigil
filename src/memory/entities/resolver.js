import { readFile } from 'node:fs/promises';

import { embed } from '../../ingestion/embedder.js';
import { prompt as llmPrompt, parseJson } from '../../lib/llm.js';
import config from '../../config.js';
import {
  insertEntity, findByName, incrementMentionCount, updateEntityTypes,
  getCanonicalEntity, pushAlias, updateName, safeParseEntityTypes,
} from './store.js';
import { findEmbeddingMatch, verifyEmbeddingMatch } from './embedding-matcher.js';

/**
 * Resolve a single entity via a 3-stage deduplication cascade:
 *   Stage 1: Exact name match (incl. aliases) — fast DB lookup
 *   Stage 2: Embedding similarity + LLM verify with episode context —
 *            catches semantic equivalents AND entity renames. The LLM gets
 *            the source passage so it can detect "X is now named Y" style
 *            rename signals that pure name-vector similarity misses.
 *   Stage 3: Co-mentioned-entity fallback — when vector matches return
 *            nothing but other entities were extracted from the same
 *            passage, give the LLM those as candidates. Lets renames pass
 *            even when the old and new names are vector-distant (Smara vs
 *            Sigil have low cosine similarity as raw strings).
 *   Stage 4: Create new entity
 *
 * `episodeText` is the message/document the entity was extracted from.
 * `episodeEntityIds` are the other entities resolved from the same passage,
 * used as candidates in Stage 3.
 */
async function resolveEntity({
  name, entityType, description, namespace, externalId,
  embedding, episodeText, episodeEntityIds = [],
}) {
  const ns = namespace || config.defaults.namespace;

  // Stage 1: Exact Name Match (canonical name OR alias)
  let existing = await findByName(name, ns);
  if (existing) {
    existing = await getCanonicalEntity(existing.id);
    await incrementMentionCount(existing.id);
    if (existing.entityType !== entityType) await updateEntityTypes(existing.id, entityType);
    return existing;
  }

  const nameEmbedding = embedding || await embed(`${entityType}: ${name}`);

  // Stage 2: Embedding-similar candidates → LLM verify with episode context
  const embeddingMatches = await findEmbeddingMatch(name, nameEmbedding, { namespace: ns, limit: 3 });

  for (const match of embeddingMatches) {
    const decision = await verifyEmbeddingMatch(name, entityType, match, episodeText);
    if (decision.same) {
      return mergeIntoExisting(match, {
        newName: name,
        entityType,
        isRename: decision.rename,
        currentName: decision.currentName,
      });
    }
  }

  // Stage 3: Co-mentioned-entity fallback. When the rename text uses two
  // vector-distant names ("Smara is now named Sigil"), the embedding gate
  // returns nothing — but the OTHER entities already resolved from the same
  // passage are exactly the rename candidates we want the LLM to consider.
  // Skip any IDs already considered in Stage 2.
  const tried = new Set(embeddingMatches.map((m) => m.id));
  const cohortIds = episodeEntityIds.filter((id) => id != null && !tried.has(id));

  for (const id of cohortIds) {
    const canonical = await getCanonicalEntity(id);
    if (!canonical) continue;
    if (canonical.namespace !== ns) continue;
    if (canonical.name?.toLowerCase() === name.toLowerCase()) continue;

    // Reuse the same verify path so the prompt + parsing stay consistent.
    const decision = await verifyEmbeddingMatch(name, entityType, {
      ...canonical,
      types: safeParseEntityTypes(canonical),
      similarity: 0, // not vector-based; signal that the LLM is judging on episode text alone
    }, episodeText);
    if (decision.same) {
      return mergeIntoExisting(canonical, {
        newName: name,
        entityType,
        isRename: decision.rename,
        currentName: decision.currentName,
      });
    }
  }

  // Stage 4: Create New Entity. Two callers may race on this — `sigil
  // remember "..." "..." "..."` runs ingests in parallel via Promise.all,
  // and parallel ingests hitting the same entity name (e.g. "TypeScript")
  // will both find no existing match in Stages 1-3 and both try to
  // insert, racing into the (name, entity_type, namespace) unique
  // constraint. Retry-on-conflict is the standard upsert pattern:
  // if the insert fails because someone else just created it, find
  // and return their entity instead.
  try {
    return await insertEntity({ name, entityType, description, namespace: ns, externalId, embedding: nameEmbedding });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await findByName(name, ns);
      if (winner) {
        const canonical = await getCanonicalEntity(winner.id);
        await incrementMentionCount(canonical.id);
        await updateEntityTypes(canonical.id, entityType);
        return canonical;
      }
    }
    throw err;
  }
}

function isUniqueViolation(err) {
  if (!err) return false;
  // Postgres SQLSTATE for unique_violation. Both pg and PGlite surface
  // this on the error code or in the message text.
  if (err.code === '23505') return true;
  if (typeof err.message === 'string' && err.message.includes('duplicate key value violates unique constraint')) return true;
  return false;
}

// Roll a new mention into an existing entity. When `isRename` is true,
// `currentName` from the LLM tells us which of (newName, existing.name)
// is the canonical going-forward name — that one becomes entity.name,
// the other lands in aliases[]. The LLM is asked because the rename
// direction can't be inferred from order alone (the new mention might
// be the old name being matched against an already-renamed entity).
async function mergeIntoExisting(match, { newName, entityType, isRename, currentName }) {
  const canonical = await getCanonicalEntity(match.id);
  await incrementMentionCount(canonical.id);
  await updateEntityTypes(canonical.id, entityType);

  if (isRename && canonical.name && canonical.name.toLowerCase() !== newName.toLowerCase()) {
    // Decide which name should be the canonical going forward.
    const nameLower = newName.toLowerCase();
    const existingLower = canonical.name.toLowerCase();
    const currentLower = (currentName || '').toLowerCase();

    let canonicalAfter;
    let aliasAfter;
    if (currentLower === nameLower) {
      canonicalAfter = newName; aliasAfter = canonical.name;
    } else if (currentLower === existingLower) {
      canonicalAfter = canonical.name; aliasAfter = newName;
    } else {
      // LLM didn't return a canonical hint — default to the new mention
      // since it's the most recent statement.
      canonicalAfter = newName; aliasAfter = canonical.name;
    }

    if (aliasAfter && aliasAfter.toLowerCase() !== canonicalAfter.toLowerCase()) {
      await pushAlias(canonical.id, aliasAfter);
      canonical.aliases = [...(canonical.aliases || []), aliasAfter.toLowerCase()];
    }
    if (canonicalAfter !== canonical.name) {
      try {
        await updateName(canonical.id, canonicalAfter);
        canonical.name = canonicalAfter;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Another ingest already created an entity with the target name
          // (e.g. another parallel rename, or a Stop-hook fact processed
          // concurrently). Merge our entity into the winner so callers
          // and existing fact_entity rows continue to work.
          const winner = await findByName(canonicalAfter, canonical.namespace);
          if (winner && winner.id !== canonical.id) {
            const { mergeEntities } = await import('./merger.js');
            await mergeEntities(winner.id, canonical.id);
            // Push our former canonical name into the winner's aliases
            // so the rename trail isn't lost.
            await pushAlias(winner.id, canonical.name);
            const refreshed = await getCanonicalEntity(winner.id);
            return refreshed;
          }
        }
        throw err;
      }
    }
  }

  return canonical;
}

/**
 * LLM-based topic extraction from facts.
 * Takes extracted facts, asks Claude for topic entities, resolves each
 * with episode context + co-mentioned entity IDs so Stage 3 can detect
 * renames the embedding gate would otherwise miss.
 */
async function resolveTopicsFromFacts(facts, { promptPath, namespace }) {
  if (!facts.length) return [];

  const factsText = facts.map((f) => `- [${f.category}] ${f.content}`).join('\n');
  const systemPrompt = await readFile(promptPath, 'utf8');
  const fullPrompt = `${systemPrompt}\n\n---\n\n${factsText}`;

  const response = await llmPrompt(fullPrompt, { model: config.llm.entityModel, caller: 'entity-resolver' });
  const parsed = parseJson(response);

  if (!Array.isArray(parsed)) return [];

  return resolveEntityList(parsed.filter((t) => t.name), { namespace, episodeText: factsText });
}

/**
 * Resolve a list of extracted { name, description } items into canonical
 * entities, with deterministic rename detection. Shared by the entity-only
 * path (resolveTopicsFromFacts) and the fused graph-extraction path.
 *
 * Two-pass resolution makes rename detection independent of the LLM's output
 * order:
 *   Pass 1: every item gets a fast exact-name lookup (Stage 1 only). Items
 *           that already exist join the "anchor cohort."
 *   Pass 2: items that didn't exist get the full resolveEntity cascade with
 *           `episodeEntityIds = anchorCohort`, so Stage 3 dedup always sees
 *           the existing same-passage entities as rename candidates.
 *
 * Without this, "Smara is now named Sigil" fails when the extractor returns
 * ["Sigil", "Smara"]: Sigil resolves first as brand-new (empty cohort), then
 * Smara hits Stage 1 and the rename signal is lost. Two-pass resolves the
 * pre-existing name first regardless of order.
 */
async function resolveEntityList(validItems, { namespace, episodeText }) {
  if (!validItems?.length) return [];

  const resolved = new Array(validItems.length);
  const anchorCohort = [];
  const needsFullResolve = [];

  for (let i = 0; i < validItems.length; i++) {
    const existing = await findByNameQuick(validItems[i].name, namespace);
    if (existing) {
      resolved[i] = existing;
      anchorCohort.push(existing.id);
    } else {
      needsFullResolve.push(i);
    }
  }

  for (const i of needsFullResolve) {
    const item = validItems[i];
    const entity = await resolveEntity({
      name: item.name,
      entityType: item.entityType || 'topic',
      description: item.description || null,
      namespace,
      episodeText,
      episodeEntityIds: anchorCohort,
    });
    resolved[i] = entity;
    if (entity?.id) anchorCohort.push(entity.id);
  }

  return resolved.filter(Boolean);
}

// Lightweight Stage 1 only — used for the two-pass ordering above.
async function findByNameQuick(name, namespace) {
  const { findByName, getCanonicalEntity, incrementMentionCount } = await import('./store.js');
  const hit = await findByName(name, namespace);
  if (!hit) return null;
  const canonical = await getCanonicalEntity(hit.id);
  await incrementMentionCount(canonical.id);
  return canonical;
}

export { resolveEntity, resolveTopicsFromFacts, resolveEntityList };
