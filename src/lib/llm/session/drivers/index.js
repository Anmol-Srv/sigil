/**
 * Session-driver registry + the adapter contract.
 *
 * A "session driver" teaches the managed-session engine how to run ONE kind of
 * agentic CLI (claude, codex, opencode, hermes, …) as a warm worker. The engine
 * (manager.js) is driver-agnostic: it owns the queue, correlation, timeouts,
 * pool, and recycle policy. Each driver only answers four CLI-specific
 * questions. This mirrors src/lib/llm/providers/ — drop a file here, register it
 * below, and a new engine is supported with zero changes to the manager.
 *
 * ── Driver contract ────────────────────────────────────────────────────────
 *   id            : string  — the source type ('claude', 'codex', …)
 *   sessionName(workerId)   — the tmux session name for a worker id
 *   buildLaunch({ workerId, sourceType, model, workerServer, scratchDir })
 *                 → { argv, files }
 *                   argv  : string[]  — argv to run inside tmux (NO shell)
 *                   files : [{ path, content, mode? }] — scratch files (mcp
 *                           config, system prompt) the manager writes first
 *   nudge(tmux, name)       — trigger the worker to pull + process one task
 *   healthcheck(tmux, name) → { healthy: boolean, reason: string|null }
 *                   inspect the pane for a wedged interactive dialog (auth /
 *                   trust / rate-limit prompt) so a stuck worker is recycled
 *                   immediately instead of only after the dead-man timeout.
 *
 * v1 ships `claude` only (per plan D6). The others are deferred behind this
 * exact contract.
 */
import { claudeDriver } from './claude.js';

const DRIVERS = {
  claude: claudeDriver,
  // codex:   codexDriver,    // deferred — implement the contract above
  // opencode: opencodeDriver,
  // hermes:  hermesDriver,
};

/** Resolve a driver by source type, or throw a clear error listing what exists. */
export function getDriver(sourceType) {
  const d = DRIVERS[sourceType];
  if (!d) {
    throw new Error(
      `No managed-session driver for source type "${sourceType}". `
      + `Available: ${Object.keys(DRIVERS).join(', ')}. `
      + `Add one under src/lib/llm/session/drivers/ implementing the driver contract.`,
    );
  }
  return d;
}

/** Source types that have a registered driver. */
export function supportedSourceTypes() {
  return Object.keys(DRIVERS);
}
