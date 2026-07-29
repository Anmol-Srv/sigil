import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

/**
 * `prime` — the session-start preamble for MCP clients (Codex, Cursor, Kiro).
 *
 * These clients have no UserPromptSubmit hook, so memory is NOT
 * injected or saved automatically. `prime` is the substitute: called once at
 * the start of a task, it returns Sigil's health status and points the agent
 * at targeted recall. It shares the
 * one preamble engine with the `sigil preamble` CLI (see
 * src/preamble/run.js).
 */
function registerPrimeTool(server) {
  server.tool(
    'prime',
    `Check whether Sigil is ready without retrieving any memories.
Use when diagnosing setup or before a risky memory operation — not as a routine
session ritual. This client has no automatic recall, so call \`search\` only
when a specific past decision, preference, or source is relevant.`,
    {},
    async () => {
      const { buildPreamble } = await import('../../preamble/run.js');
      const { renderPreamble } = await import('../../preamble/render.js');
      const result = await buildPreamble({
        call: daemonCall, // reuse the MCP server's long-lived daemon socket
      });
      return textResponse(renderPreamble(result, { format: 'md', transport: 'mcp' }));
    },
  );
}

export { registerPrimeTool };
