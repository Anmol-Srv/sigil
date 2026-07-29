# Hermes integration

Sigil ships a thin Hermes memory-provider plugin. It uses the installed `sigil`
CLI, so Hermes shares the same local daemon and memory database as other agents
without adding another database owner or long-running process.

## Quick deploy (manual)

```bash
cp -R integrations/hermes/plugin \
  ~/.hermes/hermes-agent/plugins/memory/sigil

sigil --help                          # confirm the persistent CLI is on PATH
sigil init                            # configure local DB + embedder once
hermes config set memory.provider sigil
```

Restart Hermes. Verify with `hermes memory status` (or whatever Hermes' status command surfaces).

## What the plugin does

| Hermes hook | Sigil call | Why |
|---|---|---|
| `is_available()` | `which sigil` | Avoid network calls; just check the binary exists. |
| `initialize(session_id, platform, ...)` | sets namespace = `hermes-<platform>` | Per-platform classification, see plugin/README.md. |
| `prefetch(query)` | `sigil search <q> --namespace=hermes-<platform>,default --limit=5` | Read-only recall before a turn. |
| `sync_turn(user, assistant)` | no-op | Prevents automatic capture and session/thread buildup. |
| `get_tool_schemas()` | `sigil_search`, `sigil_remember` | Lets the model explicitly drill down or save mid-turn. |

The contract Hermes expects is documented at `~/.hermes/hermes-agent/website/docs/developer-guide/memory-provider-plugin.md` on any Hermes install.

## Caveats

- **Sigil CLI must be on `PATH`** on whichever machine runs Hermes. If `which sigil` returns nothing, `is_available()` returns false and Hermes silently falls back to its built-in memory.
- **`~/.sigil/config.json` must be configured.** Run `sigil init` on the Hermes host before activating the plugin. An LLM is not required.
- **The plugin shells out for every prefetch.** Latency is local `sigil search` latency, including a one-time daemon cold start when needed.
- **`sync_turn` never writes.** This is deliberate: only `sigil_remember` creates durable memory, and it waits for a truthful success or error result.
