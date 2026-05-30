/**
 * Module-level holder for the daemon's RPC registry so other modules
 * (in particular the in-process MemoryClient) can dispatch into it
 * without circular imports through src/daemon/index.js.
 *
 * Set once at daemon boot. Reset when the daemon shuts down.
 */
let current = null;

export function setRegistry(reg) { current = reg; }
export function getRegistry() {
  if (!current) throw new Error('rpc registry not initialised — is the daemon running?');
  return current;
}
export function clearRegistry() { current = null; }

// DB health — set by the eager startup probe and refreshed on each `status`
// call. `healthy: null` = not yet checked. Lets the GUI/CLI show a loud
// "Postgres unreachable" banner instead of memory silently returning empty.
let dbHealth = { healthy: null, error: null, checkedAt: null };
export function setDbHealth(h) { dbHealth = { healthy: null, error: null, checkedAt: null, ...h }; }
export function getDbHealth() { return dbHealth; }
