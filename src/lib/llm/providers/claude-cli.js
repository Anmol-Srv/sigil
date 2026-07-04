import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import config from '../../../config.js';
import { estimateTokens } from '../log.js';
import { createSemaphore } from '../concurrency-gate.js';

/**
 * Resolve the `claude` binary to an absolute path.
 *
 * The daemon is usually spawned by launchd/systemd with a stripped PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so a bare `spawn('claude')` fails with
 * ENOENT even though `claude` is on the user's interactive PATH. We probe
 * the places it actually installs — most reliably the same bin dir as the
 * node running us (nvm/volta/global-npm put `claude` next to `node`) — and
 * fall back to the bare name so a PATH that *does* contain it still works.
 */
let resolvedClaudePath = null;
export function resolveClaudeBin() {
  if (resolvedClaudePath) return resolvedClaudePath;
  if (config.llm.cliPath) return (resolvedClaudePath = config.llm.cliPath);
  const home = homedir();
  const candidates = [
    join(dirname(process.execPath), 'claude'), // next to the node that runs us (nvm/volta/npm)
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return (resolvedClaudePath = p);
  }
  // Last resort before trusting a stripped PATH: ask the user's LOGIN shell
  // where `claude` is. A login shell sources the profile (nvm, asdf, custom
  // PATH), so this finds installs the fixed candidate list above misses —
  // the common cause of "claude CLI not found" from a launchd/systemd daemon.
  const viaShell = whichViaLoginShell('claude');
  if (viaShell) return (resolvedClaudePath = viaShell);
  return (resolvedClaudePath = 'claude'); // give up: trust PATH
}

/** Resolve a command via the user's login shell (sources their profile/PATH). */
function whichViaLoginShell(cmd) {
  const shell = process.env.SHELL || '/bin/sh';
  try {
    const r = spawnSync(shell, ['-lic', `command -v ${cmd}`], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '').trim().split('\n').pop().trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

const CLI_MODEL_MAP = {
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-6': 'opus',
};

// Fork-bomb blast-radius ceiling (defense-in-depth layer): a hard cap on how
// many headless `claude -p` processes the daemon will ever have in flight at
// once. This is an absolute safety refusal that sits BELOW the config-driven
// concurrency gate — legit parallel extraction peaks around CONCURRENCY(5) + a
// couple; a runaway recursion reaches this cap near-instantly and is refused,
// so the daemon itself can never fan out an unbounded swarm regardless of what
// any hook/shim does. Override via SIGIL_MAX_CLI_CONCURRENCY.
const MAX_INFLIGHT_CLAUDE = Number(process.env.SIGIL_MAX_CLI_CONCURRENCY) || 12;
let inFlightClaude = 0;

// Process-wide hard cap on CONCURRENT `claude` spawns. EVERY spawn path funnels
// through this one gate — the one-shot provider below, the managed-session
// fallback (session/index.js → chat()), and the stop-hook classifier — so a
// burst of calls QUEUES instead of forking 1600 processes. Limit is read live
// from config, so maxClaudeProcs (and tests) take effect without a restart.
// See concurrency-gate.js for the why. The fork-bomb ceiling above is the
// last-resort refusal if anything ever slips past this gate.
const claudeGate = createSemaphore(() => config.llm.maxClaudeProcs);

/** Live gauge of the claude-spawn gate (for `sigil status` / diagnostics). */
export function claudeProcStats() {
  return { active: claudeGate.active, waiting: claudeGate.waiting, limit: claudeGate.limit };
}

/** Spawn one `claude` process, bounded by the concurrency gate. */
function spawnClaude(args, input) {
  // Acquire a slot FIRST; the per-process timeout below starts only after a slot
  // is free, so a task waiting in the queue never burns its own dead-man clock.
  return claudeGate.run(() => rawSpawnClaude(args, input));
}

function rawSpawnClaude(args, input) {
  const timeout = config.llm.cliTimeout || 120_000;

  const bin = resolveClaudeBin();

  return new Promise((resolve, reject) => {
    // L5 ceiling: refuse to spawn past the cap. A per-chunk extraction rejected
    // here is caught by the extractor and just drops that chunk (non-fatal);
    // under a recursion it stops the swarm cold.
    if (inFlightClaude >= MAX_INFLIGHT_CLAUDE) {
      reject(new Error(`claude CLI concurrency cap (${MAX_INFLIGHT_CLAUDE}) reached — refusing spawn (fork-bomb ceiling)`));
      return;
    }
    // Recursion guard (fork-bomb fix): mark this headless invocation so Sigil's
    // own hooks (sigil-hook) no-op inside it (L2), AND run with
    // `--setting-sources project` (L1, in args) so the user-scope hooks aren't
    // even loaded. Without these, the spawned `claude -p` would inherit the
    // global hooks, which call back into Sigil -> daemon -> another `claude -p`
    // -> exponential process explosion.
    inFlightClaude++;
    let settled = false;
    const done = () => { if (!settled) { settled = true; inFlightClaude--; } };
    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SIGIL_DISABLE_HOOKS: '1' },
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      done();
      reject(new Error(`claude CLI timed out after ${timeout}ms`));
    }, timeout);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      done();
      if (err.code === 'ENOENT') {
        // Almost always a stripped-PATH daemon that can't see where `claude`
        // is installed. Point the user at the fix instead of a bare ENOENT.
        reject(new Error(
          `Failed to spawn claude CLI: '${bin}' not found. The Sigil daemon `
          + `runs with a minimal PATH and can't see your \`claude\` install. `
          + `Set LLM_CLI_PATH to its absolute path (find it with \`which claude\`) `
          + `and restart the daemon — or pick an API-key provider (openrouter/openai/anthropic).`,
        ));
        return;
      }
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      done();
      resolve({ stdout, stderr, code });
    });

    // A child that exits before we finish writing (bad flags, instant failure,
    // killed) makes stdin EPIPE. That error lands on the stdin stream, NOT on
    // `proc`, so without this handler it surfaces as an unhandled rejection that
    // can crash the daemon. Swallow it — `proc.on('close')` still delivers the
    // real exit code, so chat() reports the genuine failure.
    proc.stdin.on('error', () => {});
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// eslint-disable-next-line no-unused-vars -- jsonMode kept for interface parity
async function chat(input, { model, jsonMode = false } = {}) {
  const resolved = model || config.llm.cliModel || 'haiku';
  const cliModel = CLI_MODEL_MAP[resolved] || resolved;
  // NOTE: we deliberately do NOT pass `--json-schema`. With a permissive schema
  // the CLI coerces nested arrays/objects into JSON *strings* (e.g.
  // {"facts":"[...]"}), which breaks every promptJson consumer (fact
  // extraction, classifier routing, AUDM). Instead the prompt asks for JSON and
  // the caller's parseJson() extracts it from the result text (claude returns a
  // ```json fenced block, which parseJson handles).
  // Slim the headless Claude Code call. These steps are pure text->JSON (the full
  // task prompt is in `input`, see promptJson), so the agentic scaffolding is dead
  // weight. Measured per-call overhead: ~30.6K tokens -> ~2.4K with these flags.
  //   --setting-sources project : L1 fork-bomb root fix — do NOT load the
  //         user-scope settings, so this headless Claude never registers the
  //         user's sigil-hooks and cannot re-enter Sigil. Keeps the OAuth
  //         subscription (unlike --bare, which forces ANTHROPIC_API_KEY). Also
  //         ~5x faster (skips user settings/plugin/hook load).
  //   --strict-mcp-config : no MCP servers (also breaks the hook fork-bomb path)
  //   --tools ''          : drop built-in tool schemas (~22K tokens)
  //   --system-prompt     : replace the agentic system prompt (~5.5K tokens)
  const args = [
    '-p', '--setting-sources', 'project', '--strict-mcp-config',
    '--tools', '',
    '--system-prompt', "You are a precise assistant. Follow the user's instructions exactly. When asked for JSON, output only valid JSON and nothing else.",
    '--model', cliModel, '--output-format', 'json',
  ];

  const { stdout, stderr, code } = await spawnClaude(args, input);

  if (code !== 0) {
    throw new Error(`claude CLI exited ${code}: ${(stderr || stdout).slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Fallback: if JSON parsing fails, treat stdout as raw text
    return {
      text: stdout.trim(),
      inputTokens: estimateTokens(input),
      outputTokens: estimateTokens(stdout),
      model: cliModel,
    };
  }

  if (parsed.is_error) {
    throw new Error(`claude CLI error: ${parsed.result || 'unknown error'}`);
  }

  const text = (parsed.result || '').trim();

  const usage = parsed.usage || {};

  return {
    text,
    inputTokens: usage.input_tokens || estimateTokens(input),
    outputTokens: usage.output_tokens || estimateTokens(text),
    model: cliModel,
    cost: parsed.total_cost_usd || 0,
  };
}

// ─── Init metadata + setup ──────────────────────────────────────────────────
// `meta` drives the LLM-provider picker in `sigil init`; `setup` collects
// the env keys this provider needs. Claude CLI piggybacks on the user's
// existing `claude` binary + subscription — no key, no extra config.
const meta = {
  id: 'claude-cli',
  label: 'Claude Code',
  hint: 'uses your existing subscription — no extra API key',
};

async function setup() {
  return { env: {} };
}

export { chat, meta, setup };
