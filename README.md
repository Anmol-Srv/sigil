<div align="center">

# Cortex

**Persistent memory for Claude Code — local-first, zero-cloud.**

Every AI coding session starts from zero. Cortex fixes that.
Your architecture decisions, coding preferences, past bugs, and project context — remembered across every session, every tool, every day.

[![npm](https://img.shields.io/npm/v/@anmol-srv/cortex)](https://www.npmjs.com/package/@anmol-srv/cortex)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-native-8B5CF6)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-ISC-blue)](https://opensource.org/licenses/ISC)

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Commands](#commands) · [Integration](#claude-code-integration) · [FAQ](#faq)

</div>

---

## The problem

Every time you open Claude Code, it starts from zero.
It doesn't remember your codebase, your decisions, or the conversation you had yesterday.

You end up:
- Re-explaining the same architecture over and over
- Watching Claude repeat the same mistakes you corrected last week
- Losing hours to context-loading that should be instant

## The solution

Cortex is a **local knowledge engine** that gives Claude Code persistent memory.
It plugs in via Claude Code hooks and the Model Context Protocol (MCP) — so memory works invisibly:

- **Every prompt** → Cortex injects relevant facts before Claude answers
- **Every edit / command** → Cortex silently captures the observation
- **Every session** → Full project context is already there

No cloud. No subscription. No API key required (with Claude Code subscription).

---

## Quickstart

```bash
# Install globally
npm install -g @anmol-srv/cortex

# One-time setup (30 seconds)
cortex init

# That's it. Open Claude Code and start a new session.
```

`cortex init` runs an interactive wizard that:
1. Asks for your LLM provider (Claude Code subscription is default — zero API key needed)
2. Sets up a local PGlite database at `~/.cortex/db` (no Docker, no Postgres server)
3. Registers hooks in `~/.claude/settings.json` so Claude auto-uses memory
4. Adds `@~/.cortex/CLAUDE.md` to your global Claude config

No other steps. No cloud setup.

```bash
# Verify everything works
cortex doctor
```

```
Cortex diagnostic

  ✓ Config file — ~/.cortex/.env
  ✓ Database — PGlite (~/.cortex/db)
  ✓ Stored data — 53 docs, 47 chunks, 249 facts
  ✓ LLM provider — claude-cli (Claude Code subscription)
  ✓ Embedding provider — ollama / nomic-embed-text
  ✓ UserPromptSubmit hook — registered
  ✓ PostToolUse hook — registered
  ✓ Cortex CLAUDE.md — ~/.cortex/CLAUDE.md

All checks passed.
```

---

## How it works

Cortex is three layers of knowledge, not a flat vector store:

| Layer | What's stored | Good for |
|-------|--------------|----------|
| **Chunks** | 512-token text blocks with contextual prefixes and embeddings | "Show me the relevant section" |
| **Facts** | LLM-extracted atomic statements — categorized, deduplicated, temporally tracked | "What do we know about X?" |
| **Entity graph** | Typed nodes (people, topics, documents) with relationships | "What's related to this?" |

### The ingestion pipeline

Every document goes through 6 stages:

```
Content → Classify → Dedup Check → Parse → Chunk + Embed → Extract Facts (AUDM) → Link Entities
```

- **Classify** — LLM decides: `thought` (fast-path) / `knowledge` (full pipeline) / `noise` (skip)
- **Dedup check** — SHA-256 hash skips unchanged content
- **Parse** — Format-aware parsers: markdown, text, html, code, json
- **Chunk + embed** — 512-token chunks with contextual prefixes, vectorized via Ollama or OpenAI
- **Extract facts (AUDM)** — LLM extracts atomic facts. For each fact, the **AUDM pipeline** (Add/Update/Delete/Merge) checks similarity against existing facts and decides: skip the duplicate, update the old version, contradict the stale one, or add as new.
- **Link entities** — 3-stage entity resolution (exact → embedding + LLM verify → create) builds a knowledge graph

### The search pipeline

```
Query → Cognitive Router → (Vector + Keyword) → RRF Merge → Graph Enhancement → Results
```

- **Cognitive router** — Classifies query intent (preference / factual / entity_lookup / exploratory / temporal)
- **Hybrid search** — Vector (semantic) + keyword (exact match) merged via Reciprocal Rank Fusion
- **Graph enhancement** — For exploratory queries, traverses entity graph to surface related facts

Results in ~30ms on a knowledge base of thousands of facts.

---

## Claude Code integration

Cortex integrates with Claude Code in three complementary ways:

### 1. Hooks (automatic, invisible)

`cortex init` registers two hooks in `~/.claude/settings.json`:

- **`UserPromptSubmit`** — On every user prompt, searches Cortex for relevant facts and injects them as `additionalContext`. Claude sees the memory automatically.
- **`PostToolUse`** — On every Edit/Write/Bash, captures a lightweight observation in the background.

No `! cortex search` or `! cortex remember` commands needed. Memory is invisible.

### 2. Hot context (passive)

`cortex init` writes a top-20 hot-facts snapshot to `~/.cortex/CLAUDE.md`, auto-imported into every Claude session via `@~/.cortex/CLAUDE.md` in `~/.claude/CLAUDE.md`. Facts are ranked by importance × access count × recency.

Refreshed automatically after every `cortex remember` and `cortex ingest`. Manual refresh:

```bash
cortex context
```

### 3. MCP tools (on-demand)

Cortex registers as an MCP server with 7 tools for deep knowledge access:

| Tool | Purpose |
|------|---------|
| `search` | Hybrid search across all facts and chunks |
| `search_entity` | Find entities by name or type |
| `traverse_graph` | Navigate entity relationships (neighbors / path / related) |
| `get_fact_context` | Full detail on a fact (provenance, source document, entities) |
| `get_entity_context` | Full detail on an entity (relations, facts, mentions) |
| `status` | Knowledge base statistics |
| `ingest` | Ingest content via Claude |

To register:

```bash
cortex register
```

---

## Commands

| Command | Description |
|---------|-------------|
| `cortex init` | Interactive setup — provider, DB, hooks, Claude integration |
| `cortex doctor` | Diagnose setup (DB, LLM, embeddings, hooks) |
| `cortex remember "text"` | Save one or more facts to memory (use `--bg` for background) |
| `cortex ingest <file\|url\|glob>` | Ingest documents into the knowledge base |
| `cortex search "query"` | Search the knowledge base |
| `cortex facts [--limit=N]` | List stored facts with IDs |
| `cortex forget <id>` | Delete a fact by ID |
| `cortex namespace list` | List all namespaces with fact counts |
| `cortex namespace delete <ns> --confirm` | Delete a namespace and all its data |
| `cortex export [--format=json\|markdown]` | Export knowledge base (backup/portability) |
| `cortex context` | Refresh hot-context snapshot |
| `cortex status` | Knowledge base statistics |
| `cortex migrate` | Run database migrations |
| `cortex reset --confirm` | Reset the database (drops all data) |
| `cortex register` | Register as a Claude Code MCP server |

---

## Providers

Cortex supports four LLM providers with automatic detection:

| Provider | API key needed | Cost | Notes |
|----------|---------------|------|-------|
| **Claude Code** (`claude-cli`) | **No** — uses your existing subscription | Free with subscription | Default. Piggybacks on Claude Code auth |
| **OpenAI** | `OPENAI_API_KEY` | ~$0.15 / 1M input tokens (gpt-4o-mini) | Cheapest API option |
| **Anthropic** | `ANTHROPIC_API_KEY` | ~$0.80 / 1M input tokens (Haiku) | Direct Anthropic access |
| **Ollama** | None | Free (local) | Fully offline, uses your machine |

Embeddings:

| Provider | API key | Model | Dimensions |
|----------|---------|-------|-----------|
| **Ollama** (default) | None | `nomic-embed-text` | 768 |
| **OpenAI** | `OPENAI_API_KEY` | `text-embedding-3-small` | 1536 |

Auto-detection waterfall:
1. Explicit `LLM_PROVIDER` env var wins
2. `ANTHROPIC_API_KEY` set → Anthropic
3. `OPENAI_API_KEY` set → OpenAI
4. Ollama reachable → Ollama
5. `claude` CLI installed → Claude Code subscription

Per-task overrides via `provider:model` syntax:

```bash
LLM_EXTRACTION_MODEL=claude-cli:haiku     # cheap extraction
LLM_DECISION_MODEL=anthropic:claude-sonnet-4-6  # accurate AUDM decisions
```

---

## Files Cortex owns

```
~/.cortex/
├── .env              # Config, API keys (if any), namespace
├── db/               # PGlite embedded database (auto-created)
└── CLAUDE.md         # Instructions + hot-context snapshot for Claude

~/.claude/
├── CLAUDE.md         # @import line to ~/.cortex/CLAUDE.md (one line added)
└── settings.json     # UserPromptSubmit + PostToolUse hooks (merged, not overwritten)
```

Everything lives under `~/.cortex/`. No files in your project directory. No cloud. No external services (except Ollama for embeddings if you choose it).

---

## Benchmarks

Measured on a real knowledge base (53 docs, 249 facts) on an M-series Mac.

| Metric | Cortex | Reference |
|--------|--------|-----------|
| Search latency (avg) | **33ms** | Mem0: 1440ms (P95) |
| Search latency (p95) | **61ms** | Zep: 300ms (P95) |
| Keyword recall @5 | **77%** | Basic RAG: ~55% |
| Embedding latency | **26ms** | — |
| Tokens per query | **~1.5K** | Full context: ~26K |

See `benchmark-dashboard.html` for full comparison against Mem0, Zep, SuperLocalMemory, Ogham MCP, and Basic RAG.

---

## What makes Cortex different

| | Cortex | Mem0 | claude-mem | Obsidian |
|---|--------|------|------------|----------|
| Atomic fact extraction | ✓ | Basic | ✗ (session logs) | ✗ (manual) |
| Entity graph + relationships | ✓ | Paid only | ✗ | Manual |
| Hybrid search (vector + keyword + graph) | ✓ | Vector only | ✗ | Plugin |
| AUDM deduplication | ✓ | ✗ | ✗ | ✗ |
| Fully local (embedded DB) | ✓ | Cloud-first | ✓ (files) | ✓ |
| MCP native | ✓ | ✗ | ✓ | Plugin |
| Auto-integration via hooks | ✓ | ✗ | ✓ | ✗ |
| Zero API key mode | ✓ (claude-cli) | ✗ | ✓ | ✓ |
| Multi-format ingestion | ✓ (md/code/html/json/text) | Conversations only | ✗ | Manual |

---

## FAQ

**Q: Does Cortex work with Cursor / Windsurf / other MCP clients?**
A: The MCP interface works with any MCP client. The hooks are Claude Code specific. Cursor integration requires manual MCP registration.

**Q: Does my data leave my machine?**
A: No. Everything runs locally by default (PGlite + Ollama). If you pick the OpenAI or Anthropic LLM provider, the text sent for fact extraction leaves your machine during ingestion. Embeddings with Ollama stay local. Claude Code provider uses your existing subscription without extra data egress.

**Q: Can I back up my knowledge base?**
A: Yes. `cortex export --format=json --output=backup.json` exports all facts, entities, and documents. Or copy `~/.cortex/db/` to another machine.

**Q: What happens when my knowledge base gets large?**
A: Vector search on pgvector stays fast up to millions of vectors. Tested with thousands of facts without noticeable slowdown. Use namespaces to scope search when relevant.

**Q: Can I share a knowledge base with a team?**
A: Not yet. v1 is single-user. Team features (shared namespaces, sync) are planned for v2.

**Q: How do I debug when something breaks?**
A: Start with `cortex doctor`. It'll tell you exactly what's wrong — missing provider, hook not registered, DB issue, etc.

---

## Architecture

See `architecture.html` in this repo for a full visual breakdown of the ingestion pipeline, search flow, data model, and LLM provider system.

---

## License

ISC. Use it. Fork it. Ship with it.

---

Made by [Anmol](https://github.com/Anmol-Srv). Built because every AI coding session starting from zero was driving me crazy.
