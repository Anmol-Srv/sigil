// Unit tests for the stable launcher shims (the baked-path fix).
//
// These run fully offline — no DB, no daemon. They sandbox $HOME to a temp dir
// BEFORE importing the modules (paths are resolved from os.homedir() at import
// time, which honours $HOME), so the real ~/.sigil and ~/.claude are untouched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let SANDBOX;
let shim;
let claudeCode;
let cursor;
let codex;
let kiro;

beforeAll(async () => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'sigil-shim-test-'));
  process.env.HOME = SANDBOX; // os.homedir() reads this on POSIX
  // Import AFTER $HOME is set so module-level path constants resolve into the
  // sandbox rather than the real home directory.
  shim = await import('./shim.js');
  claudeCode = await import('./claude-code.js');
  cursor = await import('./cursor.js');
  codex = await import('./codex-cli.js');
  kiro = await import('./kiro.js');
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

describe('writeLauncherShim', () => {
  it('writes all three shims, executable, with no baked package path leaking into harness configs', async () => {
    const res = await shim.writeLauncherShim({});
    expect(res.actions.map((a) => a.action)).toEqual(['create', 'create', 'create']);

    for (const p of [shim.LAUNCHER_SHIM_PATH, shim.HOOK_SHIM_PATH, shim.MCP_SHIM_PATH]) {
      expect(existsSync(p)).toBe(true);
      // executable bit set for owner
      expect(statSync(p).mode & 0o100).toBeTruthy();
    }

    const launcher = readFileSync(shim.LAUNCHER_SHIM_PATH, 'utf8');
    expect(launcher).toContain('SIGIL_DIST=');
    expect(launcher).toContain('SIGIL_NODE=');
    expect(launcher).toContain('exec "$NODE" "$CLI"');

    const mcp = readFileSync(shim.MCP_SHIM_PATH, 'utf8');
    expect(mcp).toContain('exec "$NODE" "$SERVER" --mcp');
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    const res = await shim.writeLauncherShim({});
    expect(res.actions.every((a) => a.action === 'skip')).toBe(true);
  });

  it('hook dispatcher fails SAFE (exit 0, no output) on unknown or missing hook name', () => {
    // Unknown name: script not found → exit 0, empty stdout.
    const out = execFileSync(shim.HOOK_SHIM_PATH, ['definitely-not-a-hook'], { encoding: 'utf8' });
    expect(out).toBe('');
    // No name at all → exit 0.
    const out2 = execFileSync(shim.HOOK_SHIM_PATH, [], { encoding: 'utf8' });
    expect(out2).toBe('');
  });
});

describe('claude-code install uses the stable shim, never a baked package path', () => {
  it('writes hook commands that point at ~/.sigil/bin/sigil-hook and pass verify()', async () => {
    await claudeCode.install({});

    const settings = JSON.parse(readFileSync(join(SANDBOX, '.claude', 'settings.json'), 'utf8'));
    const commands = Object.values(settings.hooks)
      .flatMap((arr) => arr)
      .flatMap((entry) => entry.hooks)
      .map((h) => h.command);

    expect(commands.length).toBe(1);
    for (const cmd of commands) {
      expect(cmd).toContain('sigil-hook');
      // The breaking pattern we are eliminating: a frozen `node /abs/.../*.js`.
      expect(cmd).not.toMatch(/node\s+\/.*hooks\/.*\.js/);
    }

    // The shared instructions reference the stable launcher, not `which sigil`
    // or dist/cli.js.
    const md = readFileSync(join(SANDBOX, '.sigil', 'CLAUDE.md'), 'utf8');
    expect(md).toContain(join(SANDBOX, '.sigil', 'bin', 'sigil'));
    expect(md).not.toContain('dist/cli.js');

    const v = await claudeCode.verify({});
    expect(v.installed).toBe(true);

    const instructionsPath = join(SANDBOX, '.sigil', 'CLAUDE.md');
    const skillPath = join(SANDBOX, '.claude', 'skills', 'sigil', 'SKILL.md');
    writeFileSync(instructionsPath, readFileSync(instructionsPath, 'utf8').replace('sigil-instructions:v11', 'sigil-instructions:v10'));
    writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('sigil-skill:v7', 'sigil-skill:v6'));
    expect(await claudeCode.verify({})).toMatchObject({
      installed: true,
      attentionKind: 'outdated',
      attention: expect.stringContaining('sigil update'),
    });
    await claudeCode.refresh({});
    expect(await claudeCode.verify({})).toMatchObject({ installed: true, attention: null });
  });

  it('re-running install does not duplicate hooks and preserves the user\'s own hooks', async () => {
    await claudeCode.install({});
    const settings = JSON.parse(readFileSync(join(SANDBOX, '.claude', 'settings.json'), 'utf8'));
    const sigilEntries = settings.hooks.UserPromptSubmit.filter((entry) =>
      entry.hooks.some((hook) => hook.command.includes('sigil-hook')));
    expect(sigilEntries).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toBeUndefined();
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.SessionEnd).toBeUndefined();
  });
});

describe('MCP clients register the stable sigil-mcp shim, never a baked server path', () => {
  it('Cursor mcp.json command points at sigil-mcp', async () => {
    await cursor.install({});
    const cfg = JSON.parse(readFileSync(join(SANDBOX, '.cursor', 'mcp.json'), 'utf8'));
    const entry = cfg.mcpServers.sigil;
    expect(entry.command).toBe(shim.MCP_SHIM_PATH);
    expect(entry.command).toContain('sigil-mcp');
    // No baked `node /abs/dist/server.js` shape.
    expect(JSON.stringify(entry)).not.toMatch(/server\.js/);
    expect(await cursor.verify({})).toMatchObject({ installed: true });
  });

  it('Codex config.toml command points at sigil-mcp', async () => {
    await codex.install({});
    const toml = readFileSync(join(SANDBOX, '.codex', 'config.toml'), 'utf8');
    const hooks = JSON.parse(readFileSync(join(SANDBOX, '.codex', 'hooks.json'), 'utf8'));
    const skill = readFileSync(join(SANDBOX, '.codex', 'skills', 'sigil', 'SKILL.md'), 'utf8');
    expect(toml).toContain('sigil-mcp');
    expect(toml).toContain('SIGIL_AGENT = "codex"');
    expect(toml).not.toMatch(/server\.js/);
    const sigilHooks = hooks.hooks.UserPromptSubmit
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.command.includes('sigil-hook'));
    expect(sigilHooks).toHaveLength(1);
    expect(sigilHooks[0].command).toContain('SIGIL_AGENT=codex');
    expect(skill).toContain('## Preamble (run first)');
    expect(skill).toContain('Prefer the Sigil MCP `status` tool');
    expect(await codex.verify({})).toMatchObject({ installed: true });
  });

  it('Kiro mcp.json command points at sigil-mcp', async () => {
    await kiro.install({});
    const cfg = JSON.parse(readFileSync(join(SANDBOX, '.kiro', 'settings', 'mcp.json'), 'utf8'));
    const entry = cfg.mcpServers.sigil;
    expect(entry.command).toBe(shim.MCP_SHIM_PATH);
    expect(JSON.stringify(entry)).not.toMatch(/server\.js/);
    expect(await kiro.verify({})).toMatchObject({ installed: true });
  });
});
