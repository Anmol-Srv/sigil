/**
 * Parse the author-provenance flags for `sigil search`.
 *
 * Write attribution (created_by_agent / created_by_device_id) is stored on
 * every fact but was historically invisible. These flags let a human/agent
 * query a shared brain BY author:
 *
 *   --agent=<name>      e.g. claude-code | cli | cursor | codex | mcp
 *   --device=<id|name>  numeric device.id OR the friendly device.name
 *
 * Both forms `--flag=value` and `--flag value` are accepted, matching the rest
 * of the CLI. Absent flags return null so the search runs exactly as before
 * (no predicate added) — additive and backwards-compatible.
 *
 *   ['--agent=cursor']            → { agent: 'cursor', device: null }
 *   ['--device', 'laptop-b']      → { agent: null, device: 'laptop-b' }
 *   ['--agent', 'cli', '--device=3'] → { agent: 'cli', device: '3' }
 *   []                            → { agent: null, device: null }
 */
export function parseSearchAuthorFlags(args) {
  return {
    agent: extractFlag(args, '--agent'),
    device: extractFlag(args, '--device'),
  };
}

// Supports both `--flag=value` and `--flag value`. Returns null when absent or
// when the value is empty / itself another flag.
function extractFlag(args, flag) {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) {
    const v = eq.slice(flag.length + 1).trim();
    return v || null;
  }
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    const v = String(args[idx + 1]).trim();
    return v || null;
  }
  return null;
}
