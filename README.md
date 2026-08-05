# Sigil

Local-first, persistent memory for AI coding agents.

Sigil gives Claude Code, Codex, Cursor, Kiro, Hermes, and other MCP clients one
inspectable memory store on your machine. It remembers only when you or an agent
explicitly asks it to, and recall is deterministic and read-only.

## Product contract

Sigil's core is deliberately small:

- PGlite is the default database: no Docker or system Postgres required.
- One thin daemon is the only database owner.
- `remember`, `correct`, `forget`, and `ingest` are explicit durable writes.
- Search combines vector and keyword ranks with Reciprocal Rank Fusion (RRF).
- Search does not update counters, create graph edges, or invoke a generative LLM.
- Embeddings are required; a chat/generation LLM is not.
- Claude Code gets one prompt-recall hook. Other agents use the MCP server or CLI.
- Every write reports its real result; there is no detached background-save queue.

Sigil does **not** automatically capture every turn, summarize sessions, create
knowledge graphs, manage nested coding-agent sessions, or run a bundled
multi-device replication system. Those features increased resource use and made
memory behavior difficult to predict without improving the core user outcome.

## Install

Sigil requires Node.js 20 or newer.

```bash
curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh
```

That is the one install command. It creates a persistent local installation,
adds `sigil` to your PATH, then opens the same local setup flow as `sigil init`
(or runs it in the terminal when a browser is unavailable). Avoid `npx` or
`pnpx`: their temporary package directories cannot safely own durable agent
configuration.

The required setup has two choices:

1. local PGlite or an advanced external Postgres;
2. an embedding provider for semantic search.

Connecting detected coding agents is offered next, but it is optional: the CLI
and MCP server are ready as soon as storage and search are configured. Sigil
does not create a synthetic memory, capture conversations automatically, or
download a local model during setup.

### Let an AI agent set it up

Copy this into Claude Code, Codex, or another coding agent with terminal
access:

```text
Set up Sigil on this machine through the terminal. If Sigil is not installed, use the official installer:

curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh

Then run `sigil init`. Default to Sigil's built-in local database unless I explicitly ask to use an existing, Docker, or external Postgres database. Explain each provider choice in plain language. Use an embedding provider that is already configured, or ask me to provide its key without printing it. Connect only coding agents you detect. Do not install or download Ollama or models automatically. Finish with `sigil doctor` and report whether storage and memory search are healthy. Do not delete, reset, or overwrite existing Sigil data.
```

The same guarded prompt is available in the first-run GUI.

At the end of interactive setup, Sigil asks whether to configure optional
LLM-powered fact extraction. The default is **No**. Storage and search are
already ready, and an LLM is only used for explicit `--extract-facts` requests.

For a scripted setup, choose deliberately:

```bash
sigil init --with-llm  # configure it now
sigil init --no-llm    # skip the optional question
```

Configuration lives in `~/.sigil/config.json` with user-only permissions. Old
`~/.sigil/.env` installations are imported once for upgrade compatibility and
then retired.

### Updating safely

```bash
sigil update
```

Updates use the locked dependency tree, refresh Sigil's stable launchers, and
restart the local daemon. They also refresh only Sigil-owned instruction and
skill content for already-connected agents—never a user’s Codex TOML, hook
trust, unrelated rules, or MCP entries. Use `sigil update --check` to check
without changing anything.

Re-running the official installer is also safe: if its managed Git checkout
contains local edits, it saves them to a recoverable Git stash before replacing
the release files.

### Repair an interrupted install

If `sigil doctor` reports that the launchers or daemon are running from a
different directory than `~/.sigil/app`, do not use the stale `sigil` command
to update itself. Run the canonical installation directly:

```bash
node "$HOME/.sigil/app/dist/cli.js" connect --shims-only
node "$HOME/.sigil/app/dist/cli.js" daemon restart
sigil doctor --deep
```

This re-pins only Sigil's stable launchers, reloads the existing automatic-start
service from the managed install when it is enabled, and leaves agent settings
and hook trust untouched. Re-run the official installer if the managed checkout
does not exist.

## Quick start

```bash
# Store one durable fact.
sigil remember "The API uses cursor pagination"

# Recall facts and document passages.
sigil search "How does pagination work?"

# Inspect IDs, then replace or delete a fact explicitly.
sigil facts
sigil correct 42 "The API uses keyset pagination ordered by created_at"
sigil forget 42

# Ingest documents as deterministic searchable chunks.
sigil ingest ./README.md
sigil ingest "docs/**/*.md" --namespace=engineering

# Opt in to generation only for this ingestion request.
sigil ingest ./decision-log.md --extract-facts
```

Namespaces are simple isolation labels. For ordinary CLI, Claude, Codex, and
other local MCP calls made inside a Git repository, Sigil chooses a stable
project namespace automatically and searches it before the shared `default`
namespace. Explicit namespaces still override that behavior:

```bash
sigil remember "Deploys run from release branches" --namespace=engineering
sigil search "deployment" --namespace=engineering
sigil namespace list
sigil namespace delete old-project --confirm
```

## How it works

```text
Agent / CLI / MCP
        │
        ▼
local Unix socket
        │
        ▼
single Sigil daemon
   ├── explicit fact writer
   ├── deterministic document ingestion
   ├── vector + keyword RRF search
   └── bounded snapshots and operational traces
        │
        ▼
PGlite (default) or external Postgres
```

The daemon starts on demand and keeps one ownership lock for the local PGlite
database. HTTP and WebSocket support are loaded only when the local dashboard is
opened. CLI, MCP, and hooks use the socket directly.

### Storage

Facts are atomic statements with a namespace and provenance. Exact duplicates
are skipped. Corrections supersede an old fact and preserve history in one
transaction. Documents are chunked deterministically and stored with source
metadata.

### Recall

Each search:

1. embeds the query once;
2. retrieves vector and keyword candidates;
3. fuses their ranks using RRF;
4. applies deterministic relevance, confidence, and importance weighting;
5. returns results plus ranking evidence to the caller.

There is no query router, synthesis call, entity traversal, pod blending, or
read-side mutation on this path.

### Optional generation

The core storage and recall flows do not need a generative LLM. Generation is
used only after explicit opt-in, currently for document fact extraction.
Supported providers include local Ollama, OpenAI, Anthropic, OpenRouter, and a
Claude CLI provider for advanced use.

Claude CLI generation is never started during daemon boot, setup probing,
ordinary recall, or ordinary writes. When explicitly used, process concurrency
is capped at one by default and calls have bounded timeouts.

## Agent integrations

### Claude Code

`sigil init` can register one `UserPromptSubmit` hook. It performs read-only
recall before Claude receives the prompt. It does not register `PostToolUse`,
`Stop`, or `SessionEnd` capture hooks.

Explicit writes are available through the CLI instructions and MCP:

```text
Remember that this repository uses pnpm.
```

### Codex CLI

`sigil init` registers both the local stdio MCP server and one stable
`UserPromptSubmit` hook. The hook runs one bounded, read-only recall before
Codex responds. It does not run on every tool call and it never captures or
saves a conversation automatically. Codex will ask you to trust the hook the
first time it sees it; approve the Sigil command in `/hooks` to enable recall.
Until it is approved, `sigil doctor` and the Agents page show the connection as
configured but waiting for approval. If an old integration you no longer use
also appears in `/hooks`, disable or remove that hook there; Sigil never edits
another product's hook for you.

Both Codex and Claude Code also receive the same portable `sigil` skill. It is
for deliberate memory work: a small read-only preflight, a narrower follow-up
search when automatic recall is insufficient, explicit saves/corrections, and
recovery when memory is unavailable. It prefers MCP tools when exposed and
falls back to Sigil's stable CLI shim, so the workflow is not tied to one agent.

### Cursor, Kiro, and other MCP clients

Sigil registers a local stdio MCP server. It exposes exactly seven tools:

| Tool | Purpose |
|---|---|
| `prime` | Return a small health/instruction preamble |
| `search` | Read-only hybrid memory search |
| `get_fact_context` | Inspect one fact and its provenance |
| `status` | Report memory-store health and counts |
| `ingest` | Store deterministic document chunks, optionally extract facts |
| `remember` | Explicitly store atomic facts |
| `correct` | Explicitly replace an outdated fact |

There are no graph, entity, pod, or session-management tools.

For an MCP-compatible tool that Sigil does not list above, do not install a
plugin. Generate a local stdio entry and paste it into that tool's config:

```bash
sigil mcp config --format json --agent my_tool
sigil mcp test
```

The generated entry uses Sigil's stable launcher and has no network endpoint,
resident worker, automatic conversation capture, or automatic tool hook.

### Hermes

The adapter in [`integrations/hermes`](./integrations/hermes) performs read-only
prefetch and exposes explicit `sigil_search` and `sigil_remember` tools.
Hermes' per-turn `sync_turn` lifecycle callback is intentionally a no-op, so it
cannot create background threads or hidden save processes.

## CLI reference

| Command | Purpose |
|---|---|
| `sigil init [--with-llm\|--no-llm]` | Configure local memory, then choose whether to add optional fact extraction |
| `sigil update [--check\|--force]` | Safely update the local install and refresh Sigil-owned agent content |
| `sigil connect` | Repair launcher shims and client configuration |
| `sigil uninstall [--dry-run]` | Remove Sigil entries from selected clients |
| `sigil doctor` | Diagnose setup and runtime health |
| `sigil remember "fact"` | Store one or more explicit facts |
| `sigil ingest <file\|url\|glob>` | Store document chunks |
| `sigil search "query"` | Recall facts and chunks |
| `sigil why "query"` | Explain deterministic ranking evidence |
| `sigil facts` | List stored facts and IDs |
| `sigil correct <id> "replacement"` | Supersede a fact transactionally |
| `sigil forget <id>` | Delete one fact |
| `sigil namespace list` | List namespace fact counts |
| `sigil namespace delete <name> --confirm` | Delete one namespace |
| `sigil export [--format=json\|markdown]` | Export facts and documents |
| `sigil status` | Show knowledge-base counts |
| `sigil repair embeddings` | Repair missing or stale embeddings |
| `sigil migrate` | Run schema migrations through the daemon |
| `sigil reset --confirm` | Reset local data safely |
| `sigil mcp config [--format json\|toml] [--agent id]` | Print a generic MCP stdio entry for a custom tool |
| `sigil mcp test` | Verify the generic stdio MCP server with a real status call |
| `sigil daemon start\|stop\|status\|logs` | Inspect the daemon lifecycle |

Run `sigil <command> --help` for command-specific flags.

## Data ownership and recovery

The default database, configuration, logs, PID metadata, and snapshots live
under `~/.sigil/`. Sigil keeps a bounded three-snapshot recovery window rather
than an unbounded backup history. Concurrent snapshot requests are coalesced.

Useful operations:

```bash
sigil export --format=json --output=sigil-backup.json
sigil doctor
sigil repair embeddings --dry-run
```

Factory reset, namespace deletion, and trace clearing require explicit
confirmation at the daemon boundary. Reset stops only the exact recorded daemon
PID and refuses to delete data while an owner still holds the database.

## External Postgres

External Postgres remains available for users who already operate one or need a
centrally reachable database. It is an advanced deployment mode, not a
requirement for local memory.

Pointing multiple installations at one Postgres can make the same rows visible
to those installations, but Sigil does not provide a bundled offline sync,
pairing, peer-to-peer transport, conflict-resolution protocol, or multi-device
security model. Treat network exposure, credentials, backups, and access
control as infrastructure responsibilities.

## Dashboard

Run `sigil` with no command to open the loopback-only dashboard. The UI shows:

- fact, document, and chunk counts;
- a fact browser with namespace and provenance filters;
- bounded durable-write and daemon activity;
- agent connection state;
- setup and system settings.

Search is read-only, so the dashboard does not fabricate recall-hit metrics or
persist search activity.

## Development

```bash
git clone https://github.com/Anmol-Srv/sigil.git
cd sigil
npm install
npm test
npm run lint
npm run build
```

PGlite integration tests run against temporary directories. External-Postgres
tests require an explicitly configured test database.

The detailed architecture, product decisions, phase-by-phase changes, and
measured results of the core simplification are recorded in
[`Project_Architecture_Blueprint.md`](./Project_Architecture_Blueprint.md).

## License

MIT
