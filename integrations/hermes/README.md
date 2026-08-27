# Hermes integration

Sigil ships as a [Hermes Agent](https://hermes.chat) memory provider plugin. Unlike the MCP clients (Claude Code, Cursor, Codex CLI, Kiro), Hermes has a first-class Python memory-provider plugin system, so integration means dropping a package into Hermes' plugin tree and setting one config key.

## Install

```bash
sigil connect --clients hermes
```

That copies [`plugin/`](./plugin) into `$HERMES_HOME/plugins/sigil/` and sets `memory.provider: sigil` in **every** profile's `config.yaml` — the top-level `~/.hermes/config.yaml` plus each `~/.hermes/profiles/*/config.yaml`. Restart Hermes afterwards.

On a remote host, run `sigil init` there first (the plugin needs a working local DB + embedder), then `sigil connect --clients hermes`.

## One pod per profile

Hermes runs several independent agents out of one install — `igris`, `xero`, `iron` — each with its own `$HERMES_HOME`. Sigil gives **each profile its own pod**, derived from the `hermes_home` kwarg Hermes passes to `initialize()`:

```
~/.hermes/profiles/xero  →  pod  hermes:xero
~/.hermes                →  pod  hermes:<active_profile>
```

This is Hermes' own requirement, not a Sigil preference — its plugin contract states that storage paths *must* be scoped by `hermes_home`. Keying on the platform (cli/telegram/imessage) instead would have two profiles chatting on the same platform writing into one another's space.

**Isolation here means ownership, not a wall.** Every profile writes to the `default` namespace and reads it unscoped, so `xero` can recall what `igris` learned, and both see what Claude Code wrote. The pod records *who* learned a fact; it does not gate who may know it.

## What the plugin does

| Hermes hook | Sigil call | Why |
|---|---|---|
| `is_available()` | `shutil.which("sigil")` | No network call — just check the binary is on PATH. |
| `initialize(session_id, platform, hermes_home)` | — | Captures `hermes_home`; the profile is derived from it CLI-side. |
| `prefetch(query)` | `sigil search <q> --namespace=default --limit=5 --no-graph --no-route --no-synthesize` | Unscoped read of the shared brain. |
| `sync_turn(user, assistant)` | `sigil ingest-turn --user <text> --hermes-home <path>` in a daemon thread | Daemon **classifies and extracts facts**, then attaches them to the profile pod — the same path Claude Code's Stop hook uses. |
| `get_tool_schemas()` | `sigil_search`, `sigil_remember` | Lets the model drill down or save one explicit fact mid-turn. |

`sync_turn` uses `ingest-turn`, not `remember`. `remember` is the **atomic lane**: it stores a string verbatim with no extraction and rejects anything document-shaped. A whole conversational turn is not a fact, and routing turns through `remember` meant any turn containing a markdown list was rejected and silently dropped. The explicit `sigil_remember` *tool* still uses `remember`, which is correct — there the model really is handing over one short fact.

The contract Hermes expects is documented at `$HERMES_HOME/hermes-agent/website/docs/developer-guide/memory-provider-plugin.md` on any Hermes install.

## Caveats

- **`sigil` must be on `PATH`** for whatever user runs Hermes. If `which sigil` returns nothing, `is_available()` returns false and Hermes silently falls back to its built-in memory — no error, just no Sigil. Systemd units often have a minimal `PATH` that excludes `~/.sigil/bin`; check that first when memory seems inert on a server.
- **Run `sigil init` on the Hermes host** before activating the plugin.
- **The plugin shells out per turn.** Prefetch latency is `sigil search` latency (~0.4s locally). If Hermes' per-turn budget is tighter, an in-process Python↔Node bridge is the next step — out of scope for now.
- **Install location matters.** The plugin goes in `$HERMES_HOME/plugins/`, the supported third-party location. Hermes' bundled `hermes-agent/plugins/memory/` tree is documented as closed to new providers and can be overwritten by a Hermes upgrade; `sigil connect` removes any stale copy it finds there.
