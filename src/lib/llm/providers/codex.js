/**
 * Codex CLI provider — one-shot completions through the user's existing
 * `codex` install and subscription, the same trade claude-cli makes: no API
 * key, no per-token billing, at the cost of spawning a process per call.
 *
 * Invocation (verified against codex-cli 0.146.0):
 *
 *   codex exec --sandbox read-only --skip-git-repo-check \
 *     [-m <model>] --output-last-message <file> <prompt>
 *
 * Notes on each flag, because each one is load-bearing:
 *
 *  --output-last-message  writes ONLY the final assistant message to a file.
 *      `--json` emits a JSONL event stream instead, which we'd have to parse
 *      and reassemble; the file gives us the answer directly. codex also prints
 *      progress and a token tally to stdout, so stdout is NOT the answer.
 *  --sandbox read-only    codex is an agent, not a completion endpoint. Without
 *      this it may try to edit files. We only ever want text back.
 *  --skip-git-repo-check  we run in ~/.sigil, which is not a repo; codex
 *      otherwise refuses to start there.
 *  no -m by default       codex already has a configured model in
 *      ~/.codex/config.toml. Duplicating that in Sigil's config would give two
 *      sources of truth that silently disagree. Sigil passes -m only when the
 *      user explicitly picks one.
 *
 * KNOWN COST: codex loads the user's configured MCP servers on every exec,
 * which inflates the prompt (measured: ~9.9k tokens to answer "say ok") and
 * emits transport errors for unreachable ones. We cannot isolate it — pointing
 * CODEX_HOME at a scratch dir loses the credentials and auth fails outright,
 * the same trap as claude-cli's `--bare`. Trimming ~/.codex/config.toml is the
 * user's lever; extraArgs below is the escape hatch.
 */
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import config from '../../../config.js';
import { estimateTokens } from '../log.js';
import { createSemaphore } from '../concurrency-gate.js';
import { SIGIL_HOME } from '../../paths.js';
import { resolveCliBin } from './cli-bin.js';

let resolvedCodexPath = null;
export function resolveCodexBin() {
  if (resolvedCodexPath) return resolvedCodexPath;
  return (resolvedCodexPath = resolveCliBin('codex', config.llm.codexPath));
}

// Same process-wide discipline as the claude gate: a burst of ingest calls
// QUEUES instead of forking one codex per fact. Shares the maxClaudeProcs knob
// because the resource being protected is the machine, not a vendor.
const codexGate = createSemaphore(() => config.llm.maxClaudeProcs);

/** Live gauge of the codex-spawn gate (for `sigil status` / diagnostics). */
export function codexProcStats() {
  return { active: codexGate.active, waiting: codexGate.waiting, limit: codexGate.limit };
}

function rawSpawnCodex(args) {
  const timeout = config.llm.cliTimeout || 120_000;
  const bin = resolveCodexBin();

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Run isolated in ~/.sigil so a one-shot extraction never picks up a
      // project's AGENTS.md or project-scoped config. CODEX_HOME is deliberately
      // NOT overridden — that's where the credentials live.
      cwd: SIGIL_HOME,
      // Re-entrancy flag: any Sigil hook firing inside this codex no-ops at the
      // shim level, breaking the ingest → codex → Stop-hook → ingest loop.
      env: { ...process.env, SIGIL_INTERNAL_LLM: '1' },
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`codex CLI timed out after ${timeout}ms`));
    }, timeout);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(
          `Failed to spawn codex CLI: '${bin}' not found. The Sigil daemon runs `
          + 'with a minimal PATH and can\'t see your `codex` install. Set '
          + 'LLM_CODEX_PATH to its absolute path (find it with `which codex`) and '
          + 'restart the daemon — or pick an API-key provider.',
        ));
        return;
      }
      reject(new Error(`Failed to spawn codex CLI: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

const spawnCodex = (args) => codexGate.run(() => rawSpawnCodex(args));

// eslint-disable-next-line no-unused-vars -- jsonMode kept for interface parity
async function chat(input, { model, jsonMode = false } = {}) {
  // The answer comes back through a file, so each call needs its own path —
  // concurrent calls would otherwise read each other's output.
  const outPath = join(tmpdir(), `sigil-codex-${randomUUID()}.txt`);
  const resolved = model || config.llm.codexModel || null;

  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'];
  if (resolved) args.push('-m', resolved);
  args.push('--output-last-message', outPath);
  if (config.llm.codexExtraArgs?.length) args.push(...config.llm.codexExtraArgs);
  args.push(input);

  try {
    const { stdout, stderr, code } = await spawnCodex(args);

    let text = '';
    try {
      text = (await readFile(outPath, 'utf8')).trim();
    } catch { /* no file — fall through to the error paths below */ }

    if (!text) {
      // Exit 0 with no message means codex ran but produced nothing (a refused
      // tool call, an auth prompt). Report stderr, which carries the reason.
      const detail = (stderr || stdout || '').trim().slice(0, 500);
      throw new Error(
        code === 0
          ? `codex CLI returned no message${detail ? `: ${detail}` : ''}`
          : `codex CLI exited ${code}: ${detail}`,
      );
    }

    return {
      text,
      inputTokens: estimateTokens(input),
      outputTokens: estimateTokens(text),
      model: resolved || 'codex-default',
    };
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

// ─── Init metadata + setup ──────────────────────────────────────────────────
const meta = {
  id: 'codex',
  label: 'Codex CLI',
  hint: 'uses your existing Codex subscription — no extra API key',
};

async function setup() {
  return { env: {} };
}

export { chat, meta, setup };
