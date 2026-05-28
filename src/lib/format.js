/**
 * Cross-module formatting helpers.
 */

/**
 * Human-friendly uptime/duration in `1h 2m 3s` shape. Used by the CLI
 * `daemon status` verb and the `ping` handler. (PR review #26.)
 */
export function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
