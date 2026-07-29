/**
 * Per-RPC AsyncLocalStorage carrying authenticated caller info to
 * downstream code without threading parameters through every layer.
 *
 * Set by rpc-registry.dispatch around each handler invocation:
 *   { transport, agent, scope }
 *     transport — 'socket' | 'http'
 *     agent     — which agent originated the call ('claude-code', 'codex',
 *                 'cursor', 'mcp', 'cli', ...); null when unknown. PROVENANCE
 *                 only — never a retrieval scope.
 *
 * Read by leaf code that needs provenance (for example, the originating agent).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runWithRequestContext(ctx, fn) {
  return als.run(ctx, fn);
}

export function currentRequestContext() {
  return als.getStore() || null;
}

export function currentAgent() {
  // ALS (per-request, set by the daemon dispatch from the socket envelope) is
  // authoritative. Fall back to SIGIL_AGENT for IN-PROCESS direct callers that
  // bypass the daemon — notably the Claude Code hooks, which import the memory
  // code directly and never hit registry.dispatch. The daemon scrubs
  // SIGIL_AGENT from its own env at startup (see startDaemon) so a value
  // inherited from the spawning CLI can never leak into per-request stamping.
  return als.getStore()?.agent ?? process.env.SIGIL_AGENT ?? null;
}

export function currentProjectScope() {
  return als.getStore()?.scope?.projectNamespace ?? null;
}
