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
