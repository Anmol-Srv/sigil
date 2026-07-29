# Sigil Memory Provider

Persistent memory for Hermes Agent, backed by [Sigil](https://github.com/Anmol-Srv/sigil), a local-first memory system with explicit atomic facts and deterministic hybrid retrieval.

## Why this exists

You run Hermes alongside coding agents and want one inspectable memory store on
that installation. Prefetch reads the Hermes platform namespace plus `default`.
Writes happen only when the model calls `sigil_remember` after explicit intent.

## Requirements

- Sigil CLI on `PATH` — install with `curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh` (or `npm install -g @anmol-srv/sigil`; avoid `npx`/`pnpx`, which run from a throwaway cache)
- `sigil init` completed once (configures the database and embedder)
- PGlite, selected by default, or an explicitly configured external Postgres

## Setup

```bash
hermes config set memory.provider sigil
```

No additional environment variables; Sigil reads `~/.sigil/config.json`.

## How it classifies sources

Each Hermes platform writes to its own Sigil namespace:

| Hermes platform | Sigil namespace |
|---|---|
| `cli`       | `hermes-cli` |
| `imessage`  | `hermes-imessage` |
| `telegram`  | `hermes-telegram` |
| `discord`   | `hermes-discord` |
| `cron`      | `hermes-cron` |

Recall reads across **two namespaces**: the active platform's own
(`hermes-imessage`) and `default`. Both belong to the same Sigil installation.

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

Routine turns are not captured. `sync_turn` is intentionally a no-op; explicit
`sigil_remember` calls are the only write path.

## What lives where

| Layer | Where | Owns |
|---|---|---|
| This plugin | `~/.hermes/hermes-agent/plugins/memory/sigil/` | The Hermes ABC contract: initialize, prefetch, sync_turn, tool dispatch. Thin subprocess wrapper. |
| Sigil CLI | `which sigil` | Read-only hybrid search and explicit fact writes. |
| Sigil config | `~/.sigil/config.json` | Database, embedder, and optional LLM settings. |
| Sigil data | local PGlite by default | Facts, documents, chunks, provenance, and bounded operational traces. |

An external Postgres remains an advanced deployment option. Sigil does not
bundle a multi-device replication protocol or promise conflict-free offline
sync between machines.
