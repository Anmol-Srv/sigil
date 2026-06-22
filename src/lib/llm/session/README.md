# Managed-session engine

Warm, daemon-managed agent workers that amortize agentic cold-start across many
LLM calls.

## Why

The one-shot `claude-cli` provider spawns a fresh `claude -p` process per LLM
call. A single document ingest fires 5–20 calls (contextualize, extract, AUDM
decide, graph extract, classify, route), so that's 5–20 full agentic cold starts
— the RAM and Claude-subscription-usage bloat this engine exists to remove.

The engine keeps a small pool of **warm** `claude` workers alive inside `tmux`
and streams tasks to them. Workers return results **out-of-band over MCP**, so we
never parse a flaky TUI pane.

> Opt-in: `SIGIL_MANAGED_SESSION=true`. Disabled (default) → every call uses the
> proven one-shot path, so nothing breaks. On a host with no `tmux` (e.g. native
> Windows) the engine also stays on the one-shot path automatically.

## Architecture

```
┌────────────────────────────── Sigil daemon (long-lived) ───────────────────────────────┐
│  callers (UNCHANGED): extractor / classifier / router / AUDM / graph                     │
│        │  llm.promptJson(input, { model: 'claude-cli' })                                 │
│        ▼  resolveForCall() swaps claude-cli → managed-session when enabled                │
│  providers/managed-session.js ── chat() ──▶ getSessionManager().submit()                 │
│        ▼                                                                                  │
│  ┌────────────────────── SessionManager (manager.js) ──────────────────────┐             │
│  │  queue[sourceType] · pending<reqId> · pool-of-N · token-budget recycle    │             │
│  │  dispatch → driver.nudge(tmux, name) → arm dead-man timer                  │             │
│  └───────┬──────────────────────────────────────────────▲────────────────────┘            │
│          │ nudge ("SIGIL_NEXT", fixed)                   │ correlate reqId, resolve()      │
│          ▼                                               │                                 │
│   ┌─ tmux: sigil-claude-0 ─┐     internal MCP (worker-server.js, strict-mcp-config):       │
│   │ claude --bare …        │◀──  get_task() → {reqId, prompt}                              │
│   │ (warm, interactive)    │     …extract…                                                 │
│   └────────────────────────┘     submit_result(reqId, result) ─── daemon RPC ──────────────┘
│                                                                                          │
│  Miss (timeout / wedged / no callback): one-shot claude-cli + recycle worker             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Guarantees

- **Correlation** — every task carries a `reqId`; `submit_result` echoes it.
- **Idempotent** — a duplicate/late `submit_result` is ignored (resolve-once).
- **Dead-man timeout** — a worker that never calls back (wedged auth/trust
  dialog, crash, or a forgotten tool call) has its task completed via the
  one-shot fallback and the worker recycled. The engine can never be worse than
  the one-shot path.
- **Active health sweep** — `probeHealth()` scans BUSY workers for a blocking
  dialog and recycles them *before* the dead-man timeout, killing the silent-
  stall window.
- **Bounded context bleed** — workers recycle on a token budget; the driver
  system prompt orders strict per-task independence.
- **Bounded RAM** — at most `poolSize` live processes per source type.

## Files

| File | Role |
|------|------|
| `manager.js` | Driver-agnostic core: queue, correlation, timeout, pool, recycle. Fully unit-tested with injected fakes. |
| `tmux.js` | Thin, testable wrapper over the `tmux` CLI. |
| `drivers/index.js` | Driver registry + the adapter contract. |
| `drivers/claude.js` | The v1 driver — lean `claude --bare` launch, nudge, healthcheck. |
| `index.js` | Process-wide singleton holder + `initSessionManager()` (daemon boot wiring). |
| `../providers/managed-session.js` | Provider that routes to the manager, else one-shot. |
| `../../../mcp/worker-server.js` | Worker-only MCP server (`get_task` + `submit_result`) — physically separate from the public surface. |
| `../../../daemon/handlers/managed-session.js` | Daemon RPC the worker tools call. |

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `SIGIL_MANAGED_SESSION` | `false` | Master switch. |
| `SIGIL_MANAGED_POOL_SIZE` | `1` | Workers per source type (concurrency). |
| `SIGIL_MANAGED_TOKEN_BUDGET` | `60000` | Recycle a worker after ~this many tokens. |
| `SIGIL_MANAGED_TASK_TIMEOUT` | `LLM_CLI_TIMEOUT` (120000) | Dead-man timeout per task. |
| `SIGIL_MANAGED_HEALTH_PROBE_MS` | `15000` | Health-sweep interval. |

## Adding a driver (codex / opencode / hermes)

v1 ships `claude` only. To add another engine, drop a file under `drivers/`
implementing the contract and register it in `drivers/index.js`. No change to the
manager is needed — it is driver-agnostic.

```js
export const codexDriver = {
  id: 'codex',
  sessionName(workerId) { return `sigil-${workerId}`; },

  // Build the tmux launch. Must launch the CLI in a warm, interactive mode that
  // loads ONLY the worker MCP server (so get_task/submit_result are its only
  // tools) and primes it to: on each message, call get_task → process → call
  // submit_result, treating every task as fully independent.
  buildLaunch({ workerId, sourceType, model, scratchDir, workerServer }) {
    return { argv: [/* codex … */], files: [/* worker mcp config */] };
  },

  // Trigger one task (worker pulls + submits over MCP after this).
  async nudge(tmux, name) { await tmux.sendKeys(name, 'SIGIL_NEXT'); },

  // Inspect the pane for a wedged interactive dialog → recycle early.
  async healthcheck(tmux, name) {
    const pane = await tmux.capturePane(name);
    return { healthy: !/blocking pattern/.test(pane), reason: null };
  },
};
```

Requirements for a new driver's CLI: (1) an interactive mode that stays warm
across turns, (2) MCP support so it can call `submit_result`, (3) a way to inject
a one-line nudge. Then add a fallback for its source type in
`index.js → fallbackFor`.
```
