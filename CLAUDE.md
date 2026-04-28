# Cortex — Development Guidelines

Read [PROJECT.md](./PROJECT.md) for architecture overview before writing any code.

## Stack

- **Runtime:** Node.js (ES modules — use `import`/`export`, not `require`)
- **Framework:** Fastify (REST API)
- **MCP:** @modelcontextprotocol/sdk (stdio transport)
- **Database:** PostgreSQL + pgvector (Knex.js, snake_case mappers)
- **Embeddings:** Ollama (nomic-embed-text, 768 dims) — swappable to OpenAI
- **Fact extraction:** Anthropic SDK (Claude Haiku via tool_use for structured output)
- **Utilities:** lodash-es, dayjs

## Project Structure

The codebase is organized by **domain**, not by file type. Each domain owns its models, logic, and data access.

```
src/
├── ingestion/                    # Ingestion domain
│   ├── pipeline.js              # Generic document ingestion orchestrator
│   ├── parsers/                 # Format-specific content parsing
│   │   ├── index.js             # Auto-detect format, dispatch to parser
│   │   ├── markdown.js          # Markdown → sections by heading
│   │   ├── text.js              # Plain text → paragraph sections
│   │   ├── html.js              # HTML → stripped text sections
│   │   ├── code.js              # Source code → function/class sections
│   │   └── json-parser.js       # JSON → readable text
│   ├── sources/                 # Content source connectors
│   │   ├── file.js              # Local filesystem (single file or glob)
│   │   ├── url.js               # HTTP URL fetch
│   │   └── raw.js               # Direct content injection
│   ├── chunker.js               # Format-aware text splitting (shared)
│   └── embedder.js              # Ollama/OpenAI embedding abstraction
│
├── memory/                       # Knowledge storage domain
│   ├── facts/                   # Fact management
│   │   ├── extractor.js         # LLM-based atomic fact extraction
│   │   ├── store.js             # Fact CRUD + AUDM deduplication + history
│   │   ├── entity-linker.js     # Fact ↔ entity junction management (fact_entity)
│   │   └── categories.js        # Default category definitions
│   ├── entities/                # Entity graph
│   │   ├── store.js             # Entity CRUD + canonical entity tracking
│   │   ├── resolver.js          # 3-stage dedup cascade (exact → embedding → create)
│   │   ├── embedding-matcher.js # pgvector similarity matching + LLM verify
│   │   ├── merger.js            # Non-lossy entity merge (redirect relations, merge types)
│   │   ├── linker.js            # Document entity linking orchestrator
│   │   ├── relations.js         # Relation CRUD with temporal tracking
│   │   └── traversal.js         # Recursive CTE graph queries (BFS, shortest path)
│   ├── chunks/
│   │   └── store.js             # Chunk CRUD (insert, delete by document, search)
│   ├── documents/
│   │   └── store.js             # Document registry (hash tracking, metadata)
│   └── search/                  # Search engine
│       ├── vector.js            # pgvector cosine similarity search
│       ├── keyword.js           # tsvector + ts_rank search
│       ├── hybrid.js            # RRF merge + graph enhancement
│       └── graph-enhancement.js # Entity graph result enrichment
│
├── generators/                   # Output generators (MD files, indexes)
│   ├── markdown/
│   │   ├── renderer.js          # Generic MD knowledge file renderer
│   │   └── index-files.js       # _index.md, group/author index generators
│   └── output.js                # Output storage (local filesystem or S3)
│
├── mcp/                          # MCP server layer (thin — delegates to domains)
│   ├── server.js                # MCP server setup + tool registration
│   └── tools/                   # 7 tools in 4 tiers
│       ├── search.js            # Hybrid search + confidence + graph
│       ├── search-entity.js     # Entity lookup by name/type
│       ├── traverse-graph.js    # Graph navigation (neighbors/path/related)
│       ├── get-fact-context.js  # Fact detail + provenance
│       ├── get-entity-context.js # Entity detail + relations + facts
│       ├── status.js            # Knowledge base statistics
│       └── ingest.js            # Document ingestion trigger
│
├── api/                          # REST API layer
│   ├── auth.js                  # API key auth plugin + key management
│   └── routes/                  # Route handlers (thin wrappers)
│       ├── ingest.js            # POST /api/ingest, /api/ingest/batch
│       ├── search.js            # GET /api/search
│       ├── entities.js          # GET /api/entities, /:id, /neighbors, /related, /graph/path
│       ├── facts.js             # GET /api/facts/:uid
│       ├── documents.js         # GET/DELETE /api/documents
│       └── status.js            # GET /api/status
│
├── db/                           # Database infrastructure
│   ├── cortex.js                # Cortex DB connection (Knex, camelCase mappers)
│   └── migrations/              # Migration files (.cjs)
│
├── lib/                          # Shared infrastructure (not domain-specific)
│   ├── llm.js                   # Anthropic SDK wrapper (prompt, promptJson, retry)
│   └── errors.js                # Error classes
│
├── scripts/                      # Standalone scripts
│   ├── ingest.js                # Ingest files, URLs, or globs
│   └── test-search.js           # Test search queries
│
├── cli.js                        # CLI tool (cortex ingest|search|status|migrate|keys)
├── config.js                     # Environment config, defaults
├── app.js                        # Fastify app setup
└── server.js                     # Entry point (--mcp for MCP, else REST)

prompts/
├── default-extraction.md         # Generic fact extraction prompt
├── entity-extraction.md          # Topic entity extraction prompt
└── audm-decision.md              # AUDM comparison prompt
```

### Rules for Structure

1. **Domain folders own their logic.** `memory/facts/store.js` handles all fact CRUD. `ingestion/pipeline.js` orchestrates ingestion. No crossing boundaries.

2. **MCP tools and API routes are thin wrappers.** They parse input, call the domain service, format the response. No business logic in tools or routes.

3. **Parsers are format-specific, pipeline is generic.** `parsers/markdown.js` knows how to parse markdown. `pipeline.js` doesn't know or care about the input format.

4. **`lib/` is for infrastructure, not business logic.** LLM wrapper, error classes. If it's domain-specific, it goes in the domain folder.

5. **One export per file.** Each file exports a single function, class, or object.

---

## Coding Practices

### Use lodash, Not Manual Iterations

```javascript
// bad — manual reduce
const grouped = items.reduce((acc, item) => { ... }, {});

// good
import { groupBy } from 'lodash-es';
const grouped = groupBy(items, 'category');
```

Use `groupBy`, `keyBy`, `uniqBy`, `pick`, `omit`, `chunk`, `flatten`, `get`, `isEmpty`, `sortBy`, `partition`, `sumBy`.

### Avoid Reducers

Never use `.reduce()` for building objects, grouping, or accumulating. Use lodash or a simpler loop.

### async/await, Not Promise Chains

### Destructuring with Defaults

### Simple Conditionals

No nested ternaries. Use early returns or if/else.

### Optional Chaining for Safe Access

### No Unnecessary Comments

Code should be self-explanatory. Comment why, not what.

### Error Handling

Throw specific errors. Don't catch and re-throw generic errors. Only catch when you can meaningfully handle.

### Function Size

Keep functions under 40 lines. Split into smaller functions that each do one thing.

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `fact-store.js`, `graph-enhancement.js` |
| Functions | camelCase | `ingestDocument()`, `extractFacts()` |
| Classes | PascalCase | `CortexError` |
| Constants | SCREAMING_SNAKE | `MAX_CHUNK_TOKENS`, `EMBEDDING_DIMENSIONS` |
| DB columns | snake_case | `content_hash`, `created_at` |
| DB tables | snake_case | `chunk`, `fact`, `entity`, `relation` |

### Imports

Group in this order, separated by blank lines:

1. Node.js built-ins
2. External packages
3. Internal imports (relative paths)

---

## Service Boundaries

### Ingestion Domain

- **`pipeline.js` is the only public API.** Other code calls `ingestDocument(...)`, never reaches into parsers or sources directly.
- **Parsers are format-specific.** Each returns `{ text, sections, metadata }`.
- **Sources are connector-specific.** Each returns `{ content, title, sourcePath, sourceType, contentType, metadata }`.
- **The pipeline composes parsers, chunker, embedder, fact extractor, and entity linker.**

### Memory Domain

- **Facts, entities, and chunks are separate concerns** with their own stores, connected via document IDs and entity references.
- **Search is a separate sub-domain.** It reads from facts and chunks but doesn't manage them.
- **AUDM lives in `facts/store.js`.** Deduplication is a fact storage concern, not an ingestion concern.

### MCP/API Layer

- **Thin wrappers only.** Parse tool/request input, call domain function, format response.
- **No business logic.** If you're writing an if/else in a tool handler, the logic probably belongs in the domain.

### Generators Domain

- **Templates are simple string interpolation.** No template engines.
- **Generators receive fully prepared data.** They don't fetch or compute — they render.

---

## Database Conventions

### Single Database

Cortex runs its own PostgreSQL instance with pgvector.

```javascript
import cortexDb from './db/cortex.js';
const facts = await cortexDb('fact').where({ status: 'active' });
```

### Tables

Unprefixed table names: `document`, `chunk`, `fact`, `entity`, `relation`, `fact_entity`, `history`.

### Migrations

Format: `YYYYMMDDHHMMSS_description-with-hyphens.cjs`

Use `exports.up` and `exports.down` (CommonJS — Knex doesn't support ESM migrations).

### Queries

Use Knex query builder for standard queries. Raw SQL only for pgvector operations and recursive CTEs.

---

## LLM Integration

All LLM calls go through `src/lib/llm.js`, which wraps the Anthropic SDK:

```javascript
import { prompt, promptJson } from './lib/llm.js';

// Text response
const answer = await prompt('Extract facts from: ...', { model: config.llm.extractionModel });

// Structured JSON response
const facts = await promptJson('Extract facts...', { model: config.llm.extractionModel });
```

Models are configured via env vars:
- `LLM_EXTRACTION_MODEL` — fact extraction (default: claude-haiku-4-5-20251001)
- `LLM_DECISION_MODEL` — AUDM decisions (default: claude-sonnet-4-6)
- `LLM_ENTITY_MODEL` — entity verification (default: claude-haiku-4-5-20251001)

---

## Testing

- Test files live alongside source: `src/memory/facts/store.test.js`
- Use vitest (not Jest — we're ESM)
- Mock external services: Ollama, Anthropic, PostgreSQL
- Test domain logic, not MCP/API wrappers

---

## Quick Reference

```bash
# Development
npm run dev                     # Start with --watch
npm run lint                    # ESLint check
npm run lint:fix                # Auto-fix lint issues
npm run test                    # Run vitest

# Database
cortex migrate                  # Run migrations
cortex migrate --rollback       # Rollback last batch
npx knex migrate:make name      # Create new migration (.cjs)

# CLI
cortex ingest ./docs/README.md                  # Single file
cortex ingest "docs/**/*.md"                    # Glob pattern
cortex ingest https://example.com/page          # URL
cortex ingest file1.md file2.md                 # Multiple files
cortex search "authentication flow"             # Search
cortex status                                   # Knowledge base stats
cortex keys list                                # List API keys
cortex keys create --name=myapp                 # Create API key

# REST API
node src/server.js                              # Start REST API server

# MCP
node src/server.js --mcp                        # Start MCP server
```
