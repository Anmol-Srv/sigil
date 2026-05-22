# Sigil Memory Provider

Persistent memory for Hermes Agent, backed by [Sigil](https://github.com/anmolsrv/sigil) — a local-first knowledge engine with atomic facts, entity graph, and hybrid retrieval. Same memory store used by Claude Code, Cursor, Codex CLI, and Kiro.

## Why this exists

You're running Hermes on a server (e.g. via iMessage / Telegram / Discord gateway) and you also use Claude Code / Cursor / etc. on your laptop. You want **one brain** that all of them share — without copying memories around or rebuilding them per tool.

This plugin makes that real: every Hermes turn lands in a Sigil namespace, every laptop turn lands in `default`, and cross-namespace search means anyone can recall anything.

## Requirements

- Sigil CLI on `PATH` — `npm install -g @anmolsrv/sigil`
- `sigil init` completed once (configures DB, embedder, LLM provider)
- Postgres reachable from this machine (local install or shared via Tailscale / cloud)

## Setup

```bash
hermes config set memory.provider sigil
```

No additional env vars or config files — Sigil reads its own `~/.sigil/.env`.

## How it classifies sources

Each Hermes platform writes to its own Sigil namespace:

| Hermes platform | Sigil namespace |
|---|---|
| `cli`       | `hermes-cli` |
| `imessage`  | `hermes-imessage` |
| `telegram`  | `hermes-telegram` |
| `discord`   | `hermes-discord` |
| `cron`      | `hermes-cron` |

Recall reads across **two namespaces**: the active platform's own (`hermes-imessage`) AND `default` (where the user's laptop tools write). Result: a fact captured in iMessage is reachable when you're back at your laptop in Claude Code, and vice versa.

To see what's in each namespace:

```bash
sigil facts --namespace=hermes-imessage
sigil facts --namespace=default
sigil namespace list
```

## Tools exposed to the model

| Tool | Purpose |
|---|---|
| `sigil_search` | Drill-down search across this platform + `default`. The model is told to use this only when the auto-injected context didn't surface what it needed. |
| `sigil_remember` | Explicit save. The model is told to use this only when the user asks ("remember that...") or a critical fact arrives mid-turn. |

Routine fact capture happens automatically via `sync_turn` — no model action required.

## What lives where

| Layer | Where | Owns |
|---|---|---|
| This plugin | `~/.hermes/hermes-agent/plugins/memory/sigil/` | The Hermes ABC contract — initialize, prefetch, sync_turn, tool dispatch. Thin subprocess wrapper. |
| Sigil CLI | `which sigil` | Hybrid search, fact extraction, AUDM dedup, pod-aware retrieval, embedder calls. |
| Sigil config | `~/.sigil/.env` | DB connection, embedder choice, LLM provider. Run `sigil init` to reconfigure. |
| Sigil data | Postgres (`SIGIL_DB_HOST` in `~/.sigil/.env`) | All facts, entities, pods, relations. Shared across machines when they point at the same Postgres. |

## Shared brain across machines

Point `SIGIL_DB_HOST` in every machine's `~/.sigil/.env` at the *same* Postgres. Two common topologies:

1. **Server-hosted Postgres** — Postgres on this server; laptop connects over Tailscale.
2. **Cloud Postgres** — Supabase / Neon / RDS; both machines connect to it.

Either way: one DB, many writers, every namespace visible from everywhere.
