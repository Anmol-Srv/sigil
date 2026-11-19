/**
 * Connector status — one honest answer per agent, shared by the dashboard,
 * `sigil agents` and `sigil doctor`.
 *
 * "Config written" is not "working": a Codex hook nobody approved in /hooks is
 * configured but never runs. So status combines what is on disk (verify) with
 * evidence the agent actually reached Sigil (the seen stamps hooks, the MCP
 * server and the CLI write; see src/hooks/host.js).
 *
 *   state         meaning                                         nextStep / action
 *   working       configured, and the agent has used Sigil        disconnect
 *   waiting       configured, not used yet                        (firstRunHint)
 *   needs-repair  some of Sigil's entries are missing or broken   repair
 *   available     the agent is installed, Sigil isn't connected   connect
 *   unavailable   the agent isn't installed on this machine       —
 */

import { lastSeen } from '../../hooks/host.js';

// Where proof of use comes from for each agent. Codex's MCP server runs even
// when its hooks were never approved, so only a hook run counts there.
const EVIDENCE = {
  'claude-code': 'hook',
  'codex-cli': 'hook',
  cursor: 'hook',
  kiro: 'mcp',
  hermes: 'cli',
};

/**
 * @param {{ id: string, firstRunHint?: string }} client
 * @param {{ detected: boolean, verified: { installed: boolean, partial?: boolean, reason?: string } }} probe
 * @param {object} [seen]  lastSeen() result, injectable for tests
 */
export function connectorState(client, { detected, verified }, seen = lastSeen(client.id)) {
  const installed = Boolean(verified?.installed);
  const partial = !installed && Boolean(verified?.partial);
  const channel = EVIDENCE[client.id] || 'hook';
  const proof = seen?.[channel] || null;
  // Most recent sign of life on any channel, for display.
  const latest = Object.entries(seen || {})
    .map(([ch, rec]) => ({ channel: ch, ...rec }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;

  let state;
  let nextStep = null;
  if (installed && proof) {
    state = 'working';
  } else if (installed) {
    state = 'waiting';
    nextStep = client.firstRunHint || 'Start a new session in this agent';
  } else if (partial) {
    state = 'needs-repair';
    nextStep = verified?.reason || 'Some of Sigil\'s settings are missing';
  } else if (detected) {
    state = 'available';
  } else {
    state = 'unavailable';
  }

  return {
    state,
    nextStep,
    installed,
    partial,
    lastSeen: latest,
    proofChannel: channel,
    provenAt: proof?.at || null,
  };
}

/** "3 min ago" style age for an ISO timestamp. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Probe every connector and return its status row. */
export async function listConnectorStatus(clients, { deep = false } = {}) {
  return Promise.all(clients.map(async (c) => {
    const [detected, verified] = await Promise.all([
      Promise.resolve().then(() => c.detect()).catch(() => false),
      Promise.resolve().then(() => c.verify({ deep })).catch((e) => ({ installed: false, reason: e?.message })),
    ]);
    const st = connectorState(c, { detected: Boolean(detected), verified });
    return {
      id: c.id,
      label: c.label,
      hint: c.hint,
      capabilities: c.capabilities || null,
      requiresRestart: Boolean(c.requiresRestart),
      detected: Boolean(detected),
      reason: verified?.reason || null,
      ...st,
    };
  }));
}
