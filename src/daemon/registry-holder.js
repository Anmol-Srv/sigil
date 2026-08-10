/**
 * Module-level holder for the daemon's RPC registry so other modules
 * (in particular the in-process MemoryClient) can dispatch into it
 * without circular imports through src/daemon/index.js.
 *
 * Set once at daemon boot. Reset when the daemon shuts down.
 */
import { statSync } from 'node:fs';
import { SIGIL_CONFIG_PATH } from '../lib/paths.js';

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

// Provider health — set by the boot probe (probeProviders) and exposed via
// `status` so the GUI/CLI/preamble can show "LLM key revoked" / "embedder
// unreachable" instead of letting the first ingest fail silently. `null` until
// probed. The boot probe runs live; `status` serves this cached value (no live
// provider call per poll).
let providerHealth = { llm: null, embedding: null, checkedAt: null };
export function setProviderHealth(h) { providerHealth = { ...providerHealth, ...h }; }

/**
 * The cached snapshot, re-probed in the background when config.json has been
 * written since the last probe.
 *
 * The probe used to run exactly once, at boot. Anything that configured a
 * provider afterwards — `sigil init` in a terminal, an edit to config.json —
 * left the daemon serving its boot verdict forever, because nothing invalidated
 * it. A real install booted 58 seconds before setup finished and then reported
 * "LLM: not configured / EMBED: not configured" for three days while both
 * providers worked, which is the exact false alarm this cache exists to avoid.
 *
 * Keyed on file mtime rather than a setup hook because the write can happen in
 * ANY process (the CLI runs setup in-process, not over RPC) — mtime is the one
 * signal every writer shares, and it also catches a same-provider key swap that
 * comparing provider names would miss. Returns the current value immediately;
 * the refreshed one lands on a later read. At most one probe in flight.
 *
 * ponytail: any config write re-probes, not just a provider change. Config is
 * written a handful of times during setup and then essentially never, and the
 * in-flight guard collapses bursts — so the cost is a couple of probes during a
 * flow that wants fresh provider verdicts anyway. Diff the provider section if
 * config ever starts being written at runtime.
 */
export function getProviderHealth() {
  if (configWrittenSinceProbe()) refreshProviderHealth();
  return providerHealth;
}

export function configWrittenSinceProbe() {
  if (probing) return false;
  // checkedAt null → the boot probe hasn't reported yet; don't race it.
  if (providerHealth.checkedAt == null) return false;
  try {
    return statSync(SIGIL_CONFIG_PATH).mtimeMs > providerHealth.checkedAt;
  } catch {
    return false; // no config file, or an unreadable one — nothing to refresh
  }
}

let probing = false;
function refreshProviderHealth() {
  probing = true;
  (async () => {
    try {
      const { probeProviders } = await import('../lib/provider-probe.js');
      setProviderHealth(await probeProviders());
    } catch { /* probe unavailable — keep serving the previous verdict */ }
    finally { probing = false; }
  })();
}
