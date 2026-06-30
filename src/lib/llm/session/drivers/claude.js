/**
 * Claude Code session driver — runs a warm, interactive `claude` process inside
 * tmux as a headless extraction/classification worker.
 *
 * Launch is deliberately LEAN so each session carries the least possible
 * per-task overhead and the smallest possible tool surface:
 *
 *   claude --bare                  skip hooks/skills/plugins/MCP auto-discovery,
 *                                  CLAUDE.md, auto-memory
 *          --strict-mcp-config     ignore every MCP config except the one below
 *          --mcp-config <file>     load ONLY the worker MCP (get_task +
 *                                  submit_result) — these tools never touch the
 *                                  public 9-tool memory surface
 *          --append-system-prompt  prime the worker (persists across context
 *                                  resets; orders strict per-task independence)
 *          --model <haiku|…>
 *
 * Return channel: the worker calls `sigil_submit_result` over MCP. We never
 * parse this pane for results — capturePane is used only by healthcheck() to
 * detect a wedged interactive dialog (auth / trust / rate-limit) so the manager
 * recycles immediately instead of waiting out the dead-man timeout.
 */
import { fileURLToPath } from 'node:url';

import config from '../../../../config.js';
import { resolveClaudeBin } from '../../providers/claude-cli.js';

// CLI model aliases — same mapping the one-shot claude-cli provider uses.
const CLI_MODEL_MAP = {
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-6': 'opus',
};

// The single trigger we send into the pane. The system prompt below tells the
// worker that ANY message means "pull and process one task", so the exact text
// is irrelevant — it just has to submit a turn. Kept distinctive for debugging
// a captured pane.
const NUDGE = 'SIGIL_NEXT';

// Built-in slash command that resets the conversation context but keeps the
// process warm. We send it BEFORE each task so a worker never carries entities,
// facts, or state from a previous task into the next — HARD per-task isolation,
// not just the soft "ignore prior tasks" instruction in the system prompt.
// Safe under `claude --bare`: --bare is minimal mode (skip hooks/LSP/plugins);
// it does NOT disable slash commands (that needs --disable-slash-commands, which
// we never pass), and /clear is a built-in. The --append-system-prompt prime
// survives /clear, so the worker keeps its protocol across the reset.
const CLEAR = '/clear';

/** Whether to /clear between tasks. Escape hatch if /clear ever misbehaves in a
 *  given claude build: set llm.managedSession.clearBetweenTasks=false in
 *  config.json to revert to prompt-ordering only. */
function clearBetweenTasks() {
  return config.llm.managedSession.clearBetweenTasks !== false;
}

// Pane signatures that mean the worker is blocked on an interactive prompt and
// will NEVER call back on its own. Hitting any of these = recycle now.
const BLOCKING_PATTERNS = [
  /do you want to proceed/i,
  /trust the files in this folder/i,
  /❯\s*1\.\s*yes/i,
  /invalid api key/i,
  /please run\s+\/login/i,
  /usage limit reached/i,
  /approaching usage limit/i,
  /rate limit/i,
  /press enter to continue/i,
];

// Standing instruction. Lives in --append-system-prompt (NOT a chat message) so
// it survives any context reset (incl. the /clear we send between tasks) and can
// never be de-primed. Orders strict per-task independence as defense-in-depth on
// top of the hard /clear reset — belt and suspenders against cross-task bleed.
const SYSTEM_PROMPT = [
  "You are Sigil's headless worker. You run inside a long-lived session and",
  'process a stream of INDEPENDENT tasks (fact extraction, classification, JSON',
  'transforms). You have exactly two tools, from the "sigil-worker" MCP server:',
  'get_task and submit_result. On EVERY message you receive, do exactly this and',
  'nothing else:',
  '1. Call the get_task tool to fetch the next task. It returns {reqId, prompt}',
  '   or {empty: true}.',
  '2. If empty, stop and wait for the next message. Do not say anything.',
  '3. Otherwise treat task.prompt as a COMPLETELY self-contained request. Ignore',
  '   everything from any previous task. Never reference prior tasks. Never carry',
  '   state, entities, or facts forward between tasks.',
  '4. Produce exactly what prompt asks for (usually strict JSON, no prose, no',
  '   markdown fences unless the prompt asks for them).',
  '5. Call submit_result with { reqId, result } where result is your answer as a',
  '   plain string. Call it EXACTLY ONCE per task.',
  'Never write files, run shell commands, or use any other tool. Never explain.',
  'Your only outputs are those two tool calls.',
].join('\n');

export const claudeDriver = {
  id: 'claude',

  sessionName(workerId) {
    return `sigil-${workerId}`;
  },

  /**
   * Build the tmux launch for one worker. Returns argv (run with no shell) and
   * the scratch files to write first (the worker MCP config). `workerServer`
   * overrides the get_task/submit_result MCP server command (tests inject a
   * fake); production defaults to `node <runtime>/mcp/worker-server.js`.
   */
  buildLaunch({ workerId, sourceType, model, scratchDir, workerServer, nodeBin = process.execPath } = {}) {
    const cliModel = CLI_MODEL_MAP[model] || model || 'haiku';

    const server = workerServer || {
      command: nodeBin,
      // Resolves correctly in both dev (src/) and prod (dist/) — identical
      // relative layout from this driver to the MCP entry.
      args: [fileURLToPath(new URL('../../../../mcp/worker-server.js', import.meta.url))],
    };

    // The worker MCP server learns which worker it serves (and over which
    // source type) from env, so get_task pulls THIS worker's assigned task.
    const mcpConfig = {
      mcpServers: {
        'sigil-worker': {
          command: server.command,
          args: server.args,
          env: {
            ...(server.env || {}),
            SIGIL_WORKER_ID: workerId,
            SIGIL_SOURCE: sourceType,
          },
        },
      },
    };

    const cfgPath = `${scratchDir}/${workerId}.mcp.json`;

    const argv = [
      resolveClaudeBin(),
      '--bare',
      '--strict-mcp-config',
      '--mcp-config', cfgPath,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--model', cliModel,
    ];

    return {
      argv,
      files: [{ path: cfgPath, content: JSON.stringify(mcpConfig, null, 2) }],
    };
  },

  /**
   * Trigger one task. We first /clear the worker's context (hard per-task
   * isolation — no entity/state bleed from the previous task), then send the
   * nudge so the worker pulls + submits the next task over MCP. /clear is a
   * client-side reset (no inference, negligible cost) and the appended system
   * prompt survives it, so the worker keeps its protocol.
   */
  async nudge(tmux, name) {
    if (clearBetweenTasks()) await tmux.sendKeys(name, CLEAR);
    await tmux.sendKeys(name, NUDGE);
  },

  /** Scan the pane for a blocking dialog; healthy unless a known signature shows. */
  async healthcheck(tmux, name) {
    const pane = await tmux.capturePane(name, { lines: 40 });
    for (const re of BLOCKING_PATTERNS) {
      if (re.test(pane)) return { healthy: false, reason: `blocking prompt: ${re.source}` };
    }
    return { healthy: true, reason: null };
  },
};

export { NUDGE, CLEAR, SYSTEM_PROMPT, BLOCKING_PATTERNS, CLI_MODEL_MAP };
