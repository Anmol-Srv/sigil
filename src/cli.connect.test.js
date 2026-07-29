// End-to-end tests for `sigil connect` — the re-runnable client (re)registration
// command. Spawns the BUILT CLI (dist/cli.js) with a sandboxed $HOME and stdin
// detached (non-TTY), exercising the agent/CI code path. Offline: connect
// touches no DB.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'dist', 'cli.js');

// Run `sigil connect <args>` against a fresh sandbox HOME. Returns
// { status, stdout, stderr, home }.
function connect(args, { seedClaude = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sigil-connect-test-'));
  if (seedClaude) mkdirSync(join(home, '.claude'), { recursive: true });
  const res = spawnSync(process.execPath, [CLI, 'connect', ...args], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored → non-TTY branch
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', home };
}

describe('sigil connect', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`dist/cli.js not found — run \`node build.js\` first (looked at ${CLI})`);
  });

  it('rejects an unknown client id with a non-zero exit', () => {
    const { status, stdout } = connect(['--clients', 'bogus', '--dry-run']);
    expect(status).toBe(1);
    expect(stdout + '').toMatch(/Unknown client id/);
  });

  it('resolves friendly aliases (claude → claude-code, codex → codex-cli)', () => {
    const claude = connect(['--clients', 'claude', '--dry-run']);
    expect(claude.status).toBe(0);
    expect(claude.stdout).toMatch(/\[Claude Code\]/);

    const codex = connect(['--clients', 'codex', '--dry-run']);
    expect(codex.status).toBe(0);
    expect(codex.stdout).toMatch(/\[Codex CLI\]/);
  });

  it('--dry-run writes nothing to disk', () => {
    const { status, home } = connect(['--clients', 'claude-code', '--dry-run']);
    expect(status).toBe(0);
    expect(existsSync(join(home, '.sigil', 'bin', 'sigil'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it('a real run re-pins shims and writes shim-based hook config', () => {
    const { status, home } = connect(['--clients', 'claude-code']);
    expect(status).toBe(0);

    // Stable shims exist.
    expect(existsSync(join(home, '.sigil', 'bin', 'sigil'))).toBe(true);
    expect(existsSync(join(home, '.sigil', 'bin', 'sigil-hook'))).toBe(true);

    // Hooks reference the shim, never a baked `node /abs/.../*.js` path.
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const commands = Object.values(settings.hooks)
      .flatMap((arr) => arr).flatMap((e) => e.hooks).map((h) => h.command);
    expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit']);
    expect(commands.length).toBe(1);
    for (const cmd of commands) {
      expect(cmd).toContain('sigil-hook');
      expect(cmd).not.toMatch(/node\s+\/.*\.js/);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('with no clients detected and none specified, re-pins shims and exits cleanly', () => {
    // No ~/.claude seeded → nothing detected; non-TTY → no picker.
    const { status, stdout, home } = connect(['--all'], { seedClaude: false });
    expect(status).toBe(0);
    expect(stdout).toMatch(/Nothing to connect|No AI clients detected/);
    rmSync(home, { recursive: true, force: true });
  });
});
