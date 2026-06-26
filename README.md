<div align="center">

<img src="./assets/sigil.svg" alt="Sigil" width="100" height="100" />

# Sigil

### Your machine. Every agent. One brain.

Local-first memory shared across Claude Code, Codex CLI, Cursor, Kiro, and any agent that can run a shell command or speak [MCP](https://modelcontextprotocol.io/). Stored in your own Postgres. No cloud, no telemetry.

</div>

```bash
curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh
```

That's it. The installer puts Sigil on your PATH persistently, then launches it and opens a dashboard in your browser where you configure everything — database, LLM, and embedding provider — with live connection tests and one-click fixes. No config files to edit, no setup prompts in the terminal.

> **Why not `npx`?** Sigil is persistent infrastructure (a background daemon + editor hooks pinned to a path). `npx`/`pnpx` runs from a throwaway cache your package manager later deletes, which would silently break memory — so Sigil refuses to set up from there. The installer above (or `npm install -g @anmol-srv/sigil`) is the supported path.

<div align="center">

Configure in the dashboard. Open Claude Code. Memory is already wired in.

[![npm](https://img.shields.io/npm/v/@anmol-srv%2Fsigil)](https://www.npmjs.com/package/@anmol-srv/sigil)
[![Docs](https://img.shields.io/badge/docs-sigil--web.pages.dev-5e8cff)](https://sigil-web.pages.dev/docs/)
[![MCP](https://img.shields.io/badge/MCP-native-8B5CF6)](https://modelcontextprotocol.io/)
[![Benchmark](https://img.shields.io/badge/LongMemEval%20oracle-R@10%20100%25-6B1A2A)](./eval/longmemeval/RESULTS.md)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/licenses/MIT)

[**Quickstart**](#quickstart) · [Every agent](#works-with-every-agent-on-your-machine) · [How it works](#how-its-structured) · [Capabilities](#key-capabilities) · [Benchmarks](#benchmarks) · [FAQ](#faq)

</div>

---

## Why this exists

Every memory tool for AI agents ships as someone else's cloud. Your code context, your team's decisions, your preferences: all sitting in a vendor's database. That's the wrong default for the most intimate context your agents touch.

And every agent has its own walled memory. Claude doesn't see what you told Codex. Cursor doesn't know what Kiro learned this morning. You re-explain the same architecture, watch the same mistakes happen, lose hours to context-loading every session.

Sigil fixes both problems with the same primitive: a local memory layer every agent connects to.

- **In Claude Code:** four hooks (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`) auto-capture decisions, preferences, and observations as you work. Relevant memory is injected into every new prompt before Claude sees it. You write zero `sigil remember` calls.
- **Everywhere else, the `sigil` CLI is the universal interface.** Any agent that can run a shell command (Codex CLI, terminal-based assistants, CI runners, Hermes, your own scripts) can call `sigil search "..."` or `sigil remember "..."` directly. No client integration required: if the agent can shell out, it can read and write memory.
- **For MCP-aware clients** (Cursor, Continue, Cline, Windsurf, Claude Desktop, Kiro): the same memory is also exposed as a 9-tool MCP server. Same brain, structured surface for clients that prefer it.
- **Across machines:** point multiple installs at the same Postgres. A fact captured on your laptop surfaces in the agent running on your home server. No daemon, no sync protocol. Postgres handles consistency.

The pod model (sessions, projects, people, playbooks, vitals, and any pluggable kind you add) is the foundation. It's how the next layers (write-attributed multi-agent workflows, ACLs, custom integrations) will land on top of the same brain.

**What changes in practice:** Tuesday in Claude Code, you decide to route webhooks through Postgres `LISTEN/NOTIFY` instead of Redis pubsub. Thursday you open Cursor in the same repo and ask for an event handler. It already knows. Friday you spin up a Hermes agent on your home server and ask *"what's our event delivery setup?"*. Same answer, no copy-paste. The brain travels with you.

---

## Works with every agent on your machine

Sigil's wedge is one memory layer underneath everything. `sigil init` detects every coding agent on your machine and wires Sigil into each one automatically: hooks for Claude Code, MCP server registration plus client-native steering rules for the rest.

| Agent | Integration depth | Auto-wired |
|---|---|---|
| **Claude Code** | Native plugin · 4 hooks (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`) · MCP server · `@~/.sigil/CLAUDE.md` hot-context import | ✓ |
| **Codex CLI** | `~/.codex/config.toml` MCP entry · `~/.codex/AGENTS.md` steering · MCP server | ✓ |
| **Cursor** | `~/.cursor/mcp.json` MCP entry · MCP server | ✓ |
| **Kiro** | `~/.kiro/settings/mcp.json` MCP entry · `~/.kiro/steering/sigil.md` steering rule · MCP server | ✓ |
| **Continue / Cline / Windsurf** | MCP server (one-line config from `sigil register --print`) | - |
| **Hermes / OpenClaw / any custom agent** | MCP server, REST, or `sigil` CLI directly | - |
| **Any MCP-spec client** | MCP server | - |

Works with **any** agent that speaks MCP or can run a shell command. One brain on your machine. Every agent reads and writes to it.

### Two interfaces: CLI first, MCP when it fits

The `sigil` CLI is the universal interface. If your agent has a `Bash` tool, a terminal, or any way to shell out, it can use Sigil with no client-specific integration required:

```bash
sigil search "JWT auth setup"            # what does the brain know?
sigil remember "we use jose, not jsonwebtoken"  # save a fact
sigil facts --limit=20                   # list recent facts
sigil why "auth setup"                   # explain the search
```

That's exactly how Claude Code (via Bash tool), Codex CLI, terminal-based agents, Hermes, and your own CI scripts use Sigil today. The CLI is auto-detected on `PATH` once installed (the `curl … | sh` installer, or `npm install -g @anmol-srv/sigil`); agents discover it the same way they discover `git` or `node`.

For clients that prefer structured tool calls (Cursor, Continue, Cline, Claude Desktop, Kiro, any MCP-spec agent), Sigil also exposes the same memory as a 9-tool MCP server. `sigil register --print` generates the config. MCP is the second interface, not the only one.

### vs your agent's built-in memory

Every coding agent ships with a hand-edited memory file: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Kiro steering. They're per-agent, capped in size, manually maintained, and reloaded in full on every prompt. Sigil is the searchable brain behind them.

|  | Built-in (`CLAUDE.md`, `AGENTS.md`, etc.) | **Sigil** |
|---|---|---|
| Capture | Manual; you write and edit the file | Automatic via Claude Code hooks |
| Scale | Loaded fully into context every prompt | Top-K retrieved from unlimited corpus |
| Token cost | Linear in file size (caps how much you can store) | ~1.5K injected per prompt regardless of corpus size |
| Search | None; the model reads the whole file | Hybrid (pgvector + tsvector BM25 + RRF) |
| Cross-agent | Per-agent files, no sharing | One shared brain across every wired agent |
| Cross-machine | Manual sync (git, scp) | Point installs at the same Postgres |
| Freshness | Stale until you rewrite | Auto-decay, supersession, importance reweighting |
| Provenance | None | Every fact links to source + confidence + temporal validity |

You can keep using `CLAUDE.md` for hard-coded project rules. Sigil handles everything else.

---

## How it's structured

Memory lives in **pods**: typed containers with declared retrieval behaviour. Five built-in kinds today:

| Kind | Identity | Decay | Hot-context budget |
|---|---|---|---|
| `claude_session` | one per Claude Code session | 90 days | 6 slots |
| `project` | one per git root (or cwd) | never | 4 slots |
| `person` | one per contact you mention | never | 4 slots (rolling 24h active) |
| `playbook` | your user-authored runbooks | never | 3 slots (active for matching project) |
| `vital` | virtual; facts marked `importance=5` | never | 6 slots (global) |

Pods are pluggable. Adding a new kind (`codex_session`, `slack_channel`, `github_pr`, ...) means writing a contract file. No schema migrations. Retrieval is pod-aware: hot-context blends facts from your active session + project + relevant people + vital, weighted by importance × decay.

Three storage layers underneath:

1. **Chunks**: raw 512-token blocks of ingested docs, embedded via your chosen provider (Ollama / OpenAI / Voyage)
2. **Facts**: atomic statements with confidence, importance, temporal validity, supersession links
3. **Entity graph**: typed nodes (person, project, service, ...) + relations, traversed via recursive CTEs

Retrieval is hybrid: pgvector cosine + tsvector keyword fused via Reciprocal Rank Fusion, then re-ranked by ACT-R activation (recency × frequency) and Hebbian co-retrieval boosts. The full pipeline is in `src/memory/`.

### What each hook does

| Hook | What runs |
|---|---|
| `UserPromptSubmit` | Hybrid search on your prompt → top-K facts injected as `additionalContext` before Claude sees it |
| `PostToolUse` | Capture observations from `Edit` / `Write` / `Bash`; SHA-256 dedup against a 5-minute window |
| `Stop` | Classify the user's last message (preference / decision / constraint / claim), extract atomic facts + entities, AUDM (Add / Update / Delete / Merge) against existing memory to prevent duplicates |
| `SessionEnd` | Summarize the session into its `claude_session` pod; promote sticky facts to higher importance |

### Key capabilities

| Capability | What it gives you |
|---|---|
| **Universal CLI interface** | Any agent with shell access can call `sigil search` / `sigil remember` directly. Works in Claude Code (Bash tool), Codex CLI, terminal agents, Hermes, CI scripts. No client integration required |
| **Auto-capture via hooks** | Zero manual `sigil remember` calls in Claude Code; the Stop hook handles routine saves |
| **Cross-agent shared memory** | Claude Code, Codex CLI, Cursor, Kiro all read and write the same brain |
| **Cross-machine via shared DB** | Laptop + home server + cloud agent on one Postgres = one memory |
| **Hybrid search** | pgvector cosine + tsvector BM25 fused via Reciprocal Rank Fusion (one SQL query) |
| **ACT-R + Hebbian re-ranking** | Recency × frequency activation + co-retrieval boosts (cognitive-science model, not vibes) |
| **Pluggable pods** | Five built-in kinds; add `slack_channel`, `github_pr`, `codex_session`, etc. as contract files. No schema migrations |
| **AUDM dedup** | Add / Update / Delete / Merge intelligence stops fact pile-up across thousands of saves |
| **Fully air-gappable** | Pick Ollama for both LLM and embeddings. Zero data leaves your network |
| **No vendor account** | `npm install` + your Postgres = working brain. No signup, no API key required to start |
| **Hot-context snapshot** | Top-20 facts always loaded via `@~/.sigil/CLAUDE.md` import. Instant context with zero latency |
| **9-tool MCP server** | `search`, `search_entity`, `traverse_graph`, `get_fact_context`, `get_entity_context`, `get_pod`, `list_pods`, `status`, `ingest` |
| **Honest benchmarks** | Public LongMemEval oracle: R@10 = 100%, 33ms p50 search. Reproducible. No in-house corpus theater |

---

## Quickstart

Sigil needs **Postgres 13+ with the `pgvector` extension** running somewhere reachable. You bring the server; the dashboard does everything else.

### 1. Install & launch

```bash
curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh
```

This installs Sigil persistently (on your PATH), starts the daemon, and opens the dashboard in your browser. The daemon runs even before anything is configured, so the setup wizard is always reachable. Everything below happens in the UI — no terminal prompts, no editing `~/.sigil/.env` by hand.

### 2. Configure in the dashboard

The first-run wizard walks you through three things, each with a live test before it's saved:

1. **Database** — paste a connection URL (Neon, Supabase, AWS RDS, Render, Railway, CockroachDB, …) or point at a local Postgres. The dashboard tests the connection, offers one-click **Install pgvector** if the extension is missing, and runs migrations. Pooled connection URLs (e.g. Neon's `-pooler` host) are handled automatically — migrations run against the direct endpoint.
2. **LLM provider** — OpenRouter, OpenAI, Anthropic, Ollama, or your Claude Code subscription. Tested with a live call.
3. **Embedding provider** — OpenAI, Voyage, or Ollama. If your database already holds vectors at a different dimension than the provider produces, the dashboard tells you exactly how many rows are affected and lets you wipe and start fresh or cancel — never a silent failure.

When a step fails, the dashboard shows the real cause and the fix, not a generic error. Switch any provider later from **Settings → Change** — it re-tests, applies, and restarts the daemon for you.

Need a local Postgres? The pgvector image includes the extension out of the box:
```bash
docker run -d --name sigil-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=sigil_dev pgvector/pgvector:pg15
```

Finishing the wizard auto-detects every AI client on your machine (Claude Code, Codex CLI, Cursor, Kiro) and wires Sigil into each: hooks for Claude Code, MCP server registration + steering rules for the rest, plus `@~/.sigil/CLAUDE.md` in your global Claude config so hot-context is always loaded.

### Prefer the terminal?

The interactive CLI setup still works and is fully equivalent:
```bash
npm install -g @anmol-srv/sigil
sigil init                                                    # interactive
sigil init --url "postgres://user:pass@ep-foo.neon.tech/sigil?sslmode=require"  # non-interactive (CI / dotfiles)
sigil doctor                                                  # verify everything's wired
```
Re-running `sigil init` is idempotent — existing `~/.sigil/.env` keys are preserved.
```
Sigil diagnostic

  ✓ Config file: ~/.sigil/.env
  ✓ Config validation: no provider/model mismatches
  ✓ Database: Postgres @ localhost:5432/sigil
  ✓ Stored data: 0 docs, 0 chunks, 0 facts
  ✓ LLM provider: openrouter (model=google/gemini-flash-latest)
  ✓ Embedding provider: openai / text-embedding-3-large
  ✓ UserPromptSubmit hook: registered
  ✓ PostToolUse hook: registered
  ✓ Stop hook: registered
  ✓ SessionEnd hook: registered
  ✓ Sigil CLAUDE.md
  ✓ Hook errors: none

All checks passed.
```

### 3. Use it

Tell Sigil something once:

```bash
sigil remember "Project uses Postgres LISTEN/NOTIFY for events, not Redis pubsub"
```

Open Claude Code in any project tomorrow. Ask "what's our event delivery setup?" and Claude answers correctly. The `UserPromptSubmit` hook injected the fact before Claude saw your prompt.

In practice you rarely call `sigil remember` directly. The `Stop` hook runs a classifier on every user message and auto-saves anything memorable (preferences, decisions, constraints, factual claims). The `PostToolUse` hook captures observations from Edit/Write/Bash.

---

## Use with other MCP clients

`sigil init` auto-wires Codex CLI, Cursor, and Kiro on first run if it detects them. No manual config needed. For everything else (Continue, Cline, Windsurf, your custom MCP-spec agent), `sigil register --print` outputs the standard MCP config JSON:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/sigil/dist/server.js", "--mcp"],
      "env": { "DOTENV_CONFIG_PATH": "/Users/you/.sigil/.env" }
    }
  }
}
```

Drop the inner `sigil: {...}` object into your client's MCP config:

| Client | Config file | Auto-wired by `sigil init`? |
|---|---|---|
| Codex CLI | `~/.codex/config.toml` | ✓ |
| Cursor | `~/.cursor/mcp.json` (or Settings → MCP) | ✓ |
| Kiro | `~/.kiro/settings/mcp.json` | ✓ |
| Continue.dev | `~/.continue/config.json` | - |
| Cline (VS Code) | `cline_mcp_settings.json` in your VS Code user dir | - |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | - |
| Any other MCP-spec client | client's MCP config | - |

The agent now sees nine tools: `search`, `search_entity`, `traverse_graph`, `get_fact_context`, `get_entity_context`, `get_pod`, `list_pods`, `status`, `ingest`. Most agents use them well if their system prompt mentions Sigil; if not, a short nudge helps:

> "You have access to a persistent memory system called Sigil. Before answering about projects, preferences, or past decisions, call `sigil_search`. When the user shares preferences, decisions, or constraints, call `sigil_ingest` to save them."

Unlike Claude Code there's no hook layer; the agent decides when to call. Capture relies on the agent or on you running `sigil remember` from the CLI.

---

## Cross-machine memory

Point multiple installs at the same Postgres and they share one brain. Either form works — Sigil uses whichever is set:

```bash
# Discrete env (typical for a self-hosted box on your LAN/VPN)
SIGIL_DB_HOST=postgres.your-network.local sigil init

# Or a single connection URL (typical for managed Postgres)
sigil init --url "postgres://user:pass@ep-foo.neon.tech/sigil?sslmode=require"
```

`SIGIL_DATABASE_URL` (or `DATABASE_URL`) takes precedence over the discrete `SIGIL_DB_HOST/PORT/NAME/USER/PASSWORD` keys when both are present.

Both machines now share memory. A fact captured on machine 1 surfaces on machine 2's next prompt. Reads and writes go directly to Postgres; consistency is whatever Postgres gives you (which is plenty for personal memory).

Use cases this unlocks:

- **Laptop + desktop.** Same memory across both, no manual sync.
- **Local dev + cloud agent.** Your laptop's Claude Code and a Sentry-triage agent running on a VPS share one brain. The agent writes "fixed prod issue X by patching Y"; your morning prompt sees it.
- **Multi-agent workflows.** Claude Code + Hermes + Codex all hitting the same memory. Each pod kind keeps writes attributed; agents in 0.11.0+ get their own `agent:<name>` pod for write attribution.

---

## Benchmarks

### Retrieval, LongMemEval oracle split

| Metric | Sigil | Notes |
|---|---|---|
| R@1 / R@3 / R@10 | **100% / 100% / 100%** | n=100, oracle split, OpenAI top-quality stack |
| Answer correctness (LLM-judged) | **43%** | Bottlenecked by gpt-4o's temporal reasoning, not Sigil retrieval |
| Cost / Wall time | $0.21 / 37 min | Single n=100 run end-to-end |

Honest caveats in [`eval/longmemeval/RESULTS.md`](./eval/longmemeval/RESULTS.md): oracle is the easy split, n=100 is small, per-question haystack is ~25 chunks. Numbers aren't directly comparable to Mem0 / Zep / Letta runs without identical methodology. The retrieval ceiling is essentially the embedding model's quality at this scale; Sigil's architectural work (Hebbian, ACT-R, pod-aware blending) shows more at 10K+ chunks.

### Local latency

| Metric | Sigil (local Postgres) |
|---|---|
| Search latency (avg / p95) | 33ms / 61ms |
| Embedding latency | 26ms |
| Tokens injected per prompt | ~1.5K |

Hook hot-path latency (cold Node start + Postgres connect + search) is higher: 200-400ms on first invocation, then warm. If that's unacceptable, comment the `UserPromptSubmit` hook out of `~/.claude/settings.json` and rely on the hot-context `CLAUDE.md` snapshot + on-demand MCP `search`.

---

## Commands

| Command | Description |
|---|---|
| `sigil init` | Interactive setup: providers, Postgres, hooks |
| `sigil doctor` | Diagnose config, DB, providers, hook registration, error budget |
| `sigil remember "text" [--bg]` | Save fact(s) directly. `--bg` returns immediately |
| `sigil ingest <file\|url\|glob>` | Ingest one or many documents |
| `sigil search "query" [--pod-scope=auto\|global\|<name>]` | Search the brain |
| `sigil why "query"` | Explain a search: per-fact RRF / pod / kind / importance breakdown |
| `sigil kind list` / `sigil kind show <name>` | Inspect registered pod kinds |
| `sigil pod list / show / create / archive / delete` | Manage pods |
| `sigil session list / current / show <uid>` | Inspect Claude Code session pods |
| `sigil facts [--limit=N]` | List stored facts with IDs |
| `sigil forget <id>` | Delete a fact |
| `sigil context [--explain]` | Refresh / explain the hot-context snapshot |
| `sigil status` | KB statistics |
| `sigil namespace list / delete <ns> --confirm` | Manage namespaces |
| `sigil export [--format=json\|markdown]` | Export everything |
| `sigil migrate` | Run pending DB migrations |
| `sigil reset --confirm` | Drop all data (destructive) |
| `sigil register [--print]` | (Re)register the MCP server |

---

## Providers

Sigil supports five LLM providers and three embedding providers with automatic detection.

### LLM

| Provider | API key | Notes |
|---|---|---|
| **OpenRouter** | `OPENROUTER_API_KEY` | One key, namespaced models (Anthropic / OpenAI / Meta / Google / ...). Default model: `google/gemini-flash-latest`. |
| **Anthropic** | `ANTHROPIC_API_KEY` | Direct Claude access; pinned model defaults |
| **OpenAI** | `OPENAI_API_KEY` | Cheapest API option (gpt-4o-mini) |
| **Ollama** | none | Fully local, runs on your machine |
| **Claude Code** (`claude-cli`) | none | Uses your existing Claude Code subscription |

OpenRouter init has an opt-in "Advanced overrides" step that pre-fills a smart split: cheap model for high-volume extraction, Sonnet for AUDM decisions and read-time synthesis.

### Embeddings

| Provider | API key | Default model | Dim | Notes |
|---|---|---|---|---|
| **OpenAI** | `OPENAI_API_KEY` | `text-embedding-3-large` | 1024 (truncated) | Best quality/cost |
| **Voyage** | `VOYAGE_API_KEY` | `voyage-3-large` | 1024 | MTEB ~76, Anthropic-recommended |
| **Ollama** | none | `nomic-embed-text` | 768 | Free, local |

### Auto-detection waterfall

**LLM:** `LLM_PROVIDER` env > OpenRouter key > Anthropic key > OpenAI key > Ollama reachable > `claude` CLI installed.

**Embeddings:** `EMBEDDING_PROVIDER` env > Voyage key > Ollama reachable > OpenAI key.

### Per-task overrides

Route specific tasks through different models via the `provider:model` syntax:

```bash
LLM_OPENROUTER_MODEL=google/gemini-flash-latest            # default everywhere
LLM_EXTRACTION_MODEL=openrouter:qwen/qwen3.5-flash         # cheap, called per chunk
LLM_DECISION_MODEL=openrouter:anthropic/claude-sonnet-latest  # smart AUDM
SIGIL_SYNTH_MODEL=openrouter:anthropic/claude-sonnet-latest   # smart synthesis
```

---

## Files Sigil owns

```
~/.sigil/
├── .env                     # Config, API keys, Postgres connection
├── CLAUDE.md                # Instructions + hot-context snapshot
├── .hook-errors.log         # Append-only diagnostic log
└── .last-clean-doctor       # Ack timestamp for proactive warnings

~/.claude/
├── CLAUDE.md                # @import line to ~/.sigil/CLAUDE.md (one line added)
└── settings.json            # 4 hook entries (merged, not overwritten)
```

Memory itself lives in your Postgres. Embeddings stay local if you use Ollama; otherwise text leaves your machine only when calling your chosen LLM / embedding API.

---

## FAQ

**Q: Does it work with Cursor / Codex / Windsurf / Continue / Cline?**
A: Yes, anything that speaks MCP can use Sigil. See [Use with other MCP clients](#use-with-other-mcp-clients). You lose Claude Code's auto-injection and auto-saving (the four hooks); your agent calls the MCP tools when it decides to. The memory engine is identical.

**Q: Does my data leave my machine?**
A: It depends on your providers. Memory storage is your own Postgres. Embeddings with Ollama stay local. The LLM call (for fact extraction, AUDM decisions, synthesis) sends text to whichever provider you picked, OpenRouter, OpenAI, Anthropic, or Ollama-local. Pick all-local (Ollama LLM + Ollama embeddings) for zero data egress.

**Q: Can I back up the brain?**
A: `sigil export --format=json --output=backup.json` exports facts, entities, pods, and documents. Or take a Postgres dump (`pg_dump sigil > sigil.sql`). To restore on a new machine: `pg_restore` then `sigil migrate` then `sigil init` (to set up the env).

**Q: Multi-user / team support?**
A: Single-user for now. Multiple installs sharing one Postgres works (see [Cross-machine memory](#cross-machine-memory)) but write attribution and ACLs (each pod is private / shared / public) land in 0.11.0+ along with the `agent` kind.

**Q: What happens if a hook crashes?**
A: Your prompt still goes through. Every hook wraps in a top-level try/catch that fails silently, Sigil's invariant is **a broken memory layer must never block a working prompt.** Errors append to `~/.sigil/.hook-errors.log`; `sigil doctor` surfaces them. After 5 unacked errors in 24h, `sigil doctor` exits with code 1 so CI / scripts can catch it.

**Q: How do I uninstall cleanly?**
A: `npm uninstall -g @anmol-srv/sigil` removes the binary. `rm -rf ~/.sigil` removes data and config. Unwire from Claude Code by removing the sigil hook entries from `~/.claude/settings.json` and the `@~/.sigil/CLAUDE.md` line from `~/.claude/CLAUDE.md`. The Postgres database (`sigil`) and user (`sigil_app`) survive. Drop them yourself if you want them gone.

**Q: Where can I see how the retrieval pipeline actually works?**
A: Read `src/memory/search/hybrid.js` (entry point) and `src/memory/search/hybrid-sql.js` (the single-SQL RRF + ACT-R activation query). The pod kind registry contracts are in `src/memory/pods/kinds/`. Hooks are in `src/hooks/`.

---

## License

MIT. See [LICENSE](./LICENSE).
