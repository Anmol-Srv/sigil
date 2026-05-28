/**
 * Minimal argv flag parser shared across cli-handlers/*.js.
 *
 * Recognises both forms:
 *   --key=value
 *   --key value
 *   --bool          (sets to true if no non-flag arg follows)
 *
 * Positional args (anything not starting with --) are returned via the
 * caller's own filtering — pass `args.filter((a) => !a.startsWith('--'))`
 * for the conventional split.
 */
export function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    if (a.includes('=')) {
      const [k, v] = a.slice(2).split(/=(.+)/);
      out[k] = v;
      continue;
    }
    const k = a.slice(2);
    const next = args[i + 1];
    out[k] = next && !next.startsWith('--') ? args[++i] : true;
  }
  return out;
}
