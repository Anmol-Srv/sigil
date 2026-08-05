/**
 * Extract user text from a prompt-hook payload without trusting the client
 * schema. Claude and Codex currently send `prompt` as text; accepting an
 * object with a text field costs nothing and avoids forwarding `[object
 * Object]` into the strict search validator during client rollouts.
 */
export function promptText(input) {
  const prompt = input?.prompt;
  if (typeof prompt === 'string') return prompt.trim();
  if (prompt && typeof prompt === 'object' && typeof prompt.text === 'string') {
    return prompt.text.trim();
  }
  return '';
}
