---
name: cortex-maintain
description: |
  Cortex knowledge base maintenance — stats, cleanup, export, diagnostics.
  Use when the user asks about Cortex's health, wants to inspect what's stored,
  clean up old data, export their memory, or troubleshoot issues.

  Triggers on phrases: "cortex status", "how much does cortex know", "export my memory",
  "clean up cortex", "cortex broken", "diagnose cortex", "list facts", "delete fact".
---

# Cortex Maintenance

## Health & stats

- **`cortex doctor`** — full diagnostic (DB, LLM, embeddings, hooks, CLAUDE.md).
  Run this first when something looks broken. Exits non-zero if any check fails.
- **`cortex status [--namespace=<ns>]`** — counts: documents, chunks, facts, entities,
  relations. Good for capacity planning.
- **MCP `status` tool** — same output via tool call.

## Inspection & cleanup

- **`cortex facts [--limit=N] [--namespace=<ns>] [--category=<c>]`** — list facts with
  short UIDs. Use to find a specific fact to delete.
- **`cortex forget <id>`** — delete a fact by UID prefix or full UID. Irreversible.
  Use when a fact is wrong, obsolete, or captured by mistake.
- **`cortex namespace list`** — show all namespaces with fact counts.
- **`cortex namespace delete <ns> --confirm`** — cascade delete everything in a namespace.
  Use to clean up old project data or test namespaces.

## Portability

- **`cortex export --format=json --output=backup.json`** — dump all facts, entities,
  documents to JSON. For backup, migration between machines, or inspection.
- **`cortex export --format=markdown`** — human-readable export, good for review.
- **Manual backup:** copy `~/.cortex/db/` to another location. The embedded PGlite
  database is a directory; preserve it intact.

## Context refresh

- **`cortex context`** — manually refresh the hot-context snapshot in
  `~/.cortex/CLAUDE.md`. Normally auto-updates after `remember`/`ingest`.

## Workflow recommendations

- Run `cortex doctor` before reporting a bug — it often catches config issues.
- Export monthly if the knowledge base is valuable (no cloud backup by default).
- `cortex namespace delete` is permanent — double-check before confirming.
- For search quality issues, check that the expected facts exist via `cortex facts`
  before blaming search. The entity graph and AUDM dedup can make facts harder to
  find if duplicates were merged unexpectedly.

## Escalation

If `cortex doctor` reports all green but behavior is still off:
- Check hook output: `ls -l ~/.cortex/.hook-dedup.json` (dedup cache)
- Inspect recent LLM calls: check the `llm_log` table via `cortex export` or direct
  DB access
- Reset as a last resort: `cortex reset --confirm` wipes everything (no recovery).
