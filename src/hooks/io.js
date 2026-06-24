/**
 * Shared stdin reader for hook entry points.
 *
 * Hooks receive their JSON payload on stdin from the host agent. Returns the
 * trimmed payload, or '' when stdin is a TTY (manual/interactive invocation)
 * so a hand-run hook returns immediately instead of blocking on EOF.
 */
export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}
