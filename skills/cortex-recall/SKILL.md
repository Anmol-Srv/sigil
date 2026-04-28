---
name: cortex-recall
description: |
  Smart retrieval from Cortex persistent memory. Use when the user wants to recall
  what they know, find related context from past sessions, or answer "what do I
  know about X", "find related", "what decisions did we make about Y".

  Triggers on phrases: "what do I know", "recall", "find related", "look up in memory",
  "what did we decide", "have I worked on", "what's in my notes about".

  Works across all projects — Cortex memory is global.
---

# Cortex Recall

You have access to a persistent memory system via MCP tools. Use it to surface
what the user already knows rather than starting from zero or guessing.

## How to recall well

1. **Start with `search`** — hybrid search across all facts and chunks. Always do this first.
   - Use natural-language queries, not keywords. "how does our auth flow work" beats "auth".
   - `format="compact"` returns one line per category (token-efficient).
   - `limit=5` is usually enough; go higher (10-20) for exploratory questions.

2. **If you get an entity match** — Cortex will say "Matched entity: X". Drill deeper
   with `get_entity_context(entityId=...)` to see all facts + relations for that entity.

3. **For connections** — `traverse_graph(startEntityId=..., action="related", maxDepth=2)`
   walks the entity graph. Use this when the user asks "what's related to X" or you
   need multi-hop context.

4. **For specific facts** — if a search result is relevant but abbreviated,
   `get_fact_context(factId=...)` returns full content, provenance, and source document.

5. **For time-specific questions** — pass `pointInTime="2026-01-15"` to see what
   was true at that point (facts have `valid_from`/`valid_until`).

## Presenting results

- One-line summaries per fact — don't paste full content unless the user asked.
- Group by category when multiple facts share a theme.
- Include relative time when recency matters ("last week", "3 months ago").
- Cite fact IDs (`[fact:uid]`) when referencing specifics — the user can use
  `cortex forget <id>` to correct mistakes.

## When Cortex has nothing

- Say so honestly. Don't fabricate facts to fill the gap.
- Answer from your general knowledge and mark it as such.
- If the information is worth remembering, suggest: "Want me to save this to
  Cortex for next time?"
