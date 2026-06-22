/**
 * Thin, testable wrapper around the `tmux` CLI.
 *
 * The managed-session engine keeps a warm `claude` (or, later, codex/opencode/
 * hermes) process alive inside a detached tmux session so the daemon can feed it
 * many tasks without re-paying agentic cold-start per call. tmux gives us a
 * persistent, addressable, inspectable pane: we inject a tiny nudge with
 * `send-keys`, and the worker hands results back out-of-band over MCP (never by
 * scraping this pane — capture-pane here is only for health probing + debug).
 *
 *   daemon ──tmux send-keys "next⏎"──▶ [ tmux: sigil-claude-0 ]
 *                                          └─ claude --bare … (warm)
 *
 * Every primitive routes through an injectable `runner` so the manager + driver
 * can be unit-tested with a fake tmux (no real binary, no real claude). The
 * default runner shells out to the real `tmux` resolved on PATH.
 */
import { spawn } from 'node:child_process';

/**
 * Default runner: execute `tmux <args>`, optionally piping `input` to stdin,
 * resolve `{ code, stdout, stderr }`. Never rejects on a non-zero exit — the
 * caller inspects `code` — but rejects on spawn failure (ENOENT = no tmux).
 */
function defaultRunner(args, { input, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`tmux ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });

    if (input != null) proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * A handle to the tmux subsystem. Pass a custom `runner` in tests; production
 * uses the real one. All methods are async and bounded by the runner timeout.
 */
export function createTmux({ runner = defaultRunner } = {}) {
  /** Is the tmux binary present and runnable? Caches nothing — cheap + boot-once. */
  async function available() {
    try {
      const { code } = await runner(['-V']);
      return code === 0;
    } catch {
      return false; // ENOENT (Windows / not installed) or timeout
    }
  }

  /**
   * Start a detached session named `name` running `command`. `command` is an
   * argv array; we pass it through tmux's own argv (NOT a shell string) so a
   * worker launch command with quotes/spaces can never be re-parsed by a shell.
   */
  async function newSession(name, command, { env } = {}) {
    // `tmux new-session -d -s <name> -- <argv...>` runs argv directly with no
    // intermediate shell, so special chars in flags are safe.
    const args = ['new-session', '-d', '-s', name];
    if (env) {
      for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    }
    args.push('--', ...command);
    const { code, stderr } = await runner(args);
    if (code !== 0) throw new Error(`tmux new-session "${name}" failed: ${stderr.trim() || `exit ${code}`}`);
  }

  /** Does a session with this name exist? */
  async function hasSession(name) {
    try {
      const { code } = await runner(['has-session', '-t', name]);
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Send literal text then Enter into a session's pane. Two calls on purpose:
   * `-l` makes the payload literal (tmux won't interpret it as key names), and
   * a separate `Enter` submits it — the robust idiom for injecting a command.
   */
  async function sendKeys(name, text, { enter = true } = {}) {
    const lit = await runner(['send-keys', '-t', name, '-l', text]);
    if (lit.code !== 0) throw new Error(`tmux send-keys "${name}" failed: ${lit.stderr.trim() || `exit ${lit.code}`}`);
    if (enter) {
      const ret = await runner(['send-keys', '-t', name, 'Enter']);
      if (ret.code !== 0) throw new Error(`tmux send-keys Enter "${name}" failed: ${ret.stderr.trim() || `exit ${ret.code}`}`);
    }
  }

  /** Capture the visible pane text (health probing + debug only, never parsed for results). */
  async function capturePane(name, { lines = 50 } = {}) {
    try {
      const { code, stdout } = await runner(['capture-pane', '-t', name, '-p', '-S', `-${lines}`]);
      return code === 0 ? stdout : '';
    } catch {
      return '';
    }
  }

  /** Kill a session if it exists. Never throws — recycle/shutdown must be best-effort. */
  async function killSession(name) {
    try { await runner(['kill-session', '-t', name]); } catch { /* already gone */ }
  }

  /** List all session names (used to reconcile orphans on daemon boot). */
  async function listSessions() {
    try {
      const { code, stdout } = await runner(['list-sessions', '-F', '#{session_name}']);
      if (code !== 0) return [];
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  return { available, newSession, hasSession, sendKeys, capturePane, killSession, listSessions };
}

export { defaultRunner };
