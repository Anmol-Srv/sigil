# Hermes integration

Sigil ships as a [Hermes Agent](https://hermes.chat) memory provider plugin. The plugin source lives at [`plugin/`](./plugin) — copy that directory into Hermes' plugin tree on whichever machine runs Hermes.

## Quick deploy (manual)

```bash
# 1. From the Sigil repo root on your laptop:
scp -r integrations/hermes/plugin/ \
    claude@neutron:.hermes/hermes-agent/plugins/memory/sigil/

# 2. On the server:
ssh claude@neutron
sigil --help                          # confirm sigil CLI is on PATH
sigil init                            # configure DB + embedder + LLM (once)
hermes config set memory.provider sigil
```

Restart Hermes. Verify with `hermes memory status` (or whatever Hermes' status command surfaces).

## What the plugin does

| Hermes hook | Sigil call | Why |
|---|---|---|
| `is_available()` | `which sigil` | Avoid network calls; just check the binary exists. |
| `initialize(session_id, platform, ...)` | sets namespace = `hermes-<platform>` | Per-platform classification — see plugin/README.md. |
| `prefetch(query)` | `sigil search <q> --namespace=hermes-<platform>,default --limit=5 --no-graph` | Fast cross-namespace recall = the shared brain. |
| `sync_turn(user, assistant)` | `sigil remember --bg "<user>"` in a daemon thread | Non-blocking. Sigil's classifier decides what's worth keeping. |
| `get_tool_schemas()` | `sigil_search`, `sigil_remember` | Lets the model explicitly drill down or save mid-turn. |

The contract Hermes expects is documented at `~/.hermes/hermes-agent/website/docs/developer-guide/memory-provider-plugin.md` on any Hermes install.

## Future: one-shot install via `sigil init`

A `src/lib/clients/hermes.js` module (5th client alongside Claude Code / Cursor / Codex / Kiro) would let `sigil init` copy this plugin into `~/.hermes/hermes-agent/plugins/memory/sigil/` and flip `memory.provider: sigil` in `config.yaml` automatically. That lands when we're confident the manual deploy works end-to-end.

## Caveats

- **Sigil CLI must be on `PATH`** on whichever machine runs Hermes. If `which sigil` returns nothing, `is_available()` returns false and Hermes silently falls back to its built-in memory.
- **`~/.sigil/.env` must be configured** — run `sigil init` on the Hermes host before activating the plugin.
- **The plugin shells out for every prefetch.** Latency is `sigil search` latency. The plugin keeps this path retrieval-only; if Hermes' per-turn budget is tighter, we could move to in-process via a Python<>Node bridge — out of scope for v0.1.
