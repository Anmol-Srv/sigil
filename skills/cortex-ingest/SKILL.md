---
name: cortex-ingest
description: |
  Save new knowledge to Cortex persistent memory. Use when the user shares
  a decision, preference, fact, or asks you to remember something.

  Triggers on phrases: "remember that", "save this", "add to memory", "note that",
  "I prefer", "we decided", "for future reference", "keep this in mind".

  Also use proactively when the user states something that's likely to be useful
  across sessions (architecture decisions, coding preferences, domain facts, etc.).
---

# Cortex Ingest

You have an `ingest` MCP tool and can invoke `cortex remember` / `cortex ingest`
from shell. Use them to make knowledge persistent.

## What to capture

**Yes:** Architecture decisions, coding preferences, project context, domain facts,
conventions, naming schemes, bugs/gotchas discovered, library choices and their rationale.

**No:** Trivial exchanges ("hi", "ok"), one-off calculations, sensitive credentials
(Cortex's hooks mask most secrets, but don't rely on it), information that changes
constantly (current time, live server status).

## How to save

1. **Search before storing** — `search("topic")` first to avoid duplicates. If a
   similar fact exists, update it rather than creating a new one. Cortex's AUDM
   pipeline handles this automatically but searching first is politer to token budgets.

2. **Atomic facts, not summaries** — "Deploy runs on AWS ECS with ECR images" beats
   "We discussed deployment and decided on AWS". One concept per fact.

3. **Use `cortex remember` for quick facts:**
   ```
   cortex remember "PostgreSQL 16 is the production database"
   ```
   Multiple quoted args save multiple facts in one call:
   ```
   cortex remember "fact one" "fact two" "fact three"
   ```
   Use `--bg` to return immediately (fire-and-forget background save):
   ```
   cortex remember --bg "fact"
   ```

4. **Use `cortex ingest` or the MCP `ingest` tool for documents/URLs:**
   ```
   cortex ingest ./docs/architecture.md
   cortex ingest https://example.com/api-reference
   cortex ingest "docs/**/*.md"
   ```

## Tag taxonomy (optional, helpful)

When saving, use consistent category hints in the fact itself:
- `preference` — personal working style
- `decision` — architectural or design choice with rationale
- `gotcha` — non-obvious thing that bit us once
- `convention` — team or project naming/structure pattern
- `architecture` — system component or data flow
- `domain` — business/product knowledge

## After saving

- Report count briefly: "Remembered (2 new, 1 updated)".
- Don't read back the entire fact unless the user asked — confirmation is enough.
- If AUDM flagged a contradiction with an older fact, mention it: "This contradicts
  fact X from last month — which is current?"
