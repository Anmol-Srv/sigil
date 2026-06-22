// Tmux wrapper — every primitive routes through an injectable runner, so these
// exercise the real argv construction + exit-code handling with NO real tmux.

import { describe, it, expect } from 'vitest';

import { createTmux } from './tmux.js';

// A fake runner that records calls and returns scripted results. `script` maps
// the first arg (the tmux subcommand) to { code, stdout, stderr } or a thrower.
function fakeRunner(script = {}) {
  const calls = [];
  const runner = async (args, opts) => {
    calls.push({ args, opts });
    const key = args[0];
    const r = script[key];
    if (typeof r === 'function') return r(args, opts);
    return r || { code: 0, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

describe('createTmux', () => {
  it('available() is true when `tmux -V` exits 0, false on ENOENT', async () => {
    expect(await createTmux({ runner: fakeRunner({ '-V': { code: 0, stdout: 'tmux 3.4' } }) }).available()).toBe(true);

    const thrower = fakeRunner();
    thrower.calls.length = 0;
    const noTmux = createTmux({ runner: async () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }); } });
    expect(await noTmux.available()).toBe(false);
  });

  it('newSession passes argv after `--` with no shell, and injects env', async () => {
    const runner = fakeRunner({ 'new-session': { code: 0 } });
    const tmux = createTmux({ runner });
    await tmux.newSession('sigil-claude-0', ['claude', '--bare', '--model', 'haiku'], { env: { SIGIL_WORKER_ID: 'claude-0' } });

    const { args } = runner.calls[0];
    expect(args[0]).toBe('new-session');
    expect(args).toContain('-d');
    expect(args).toContain('-s');
    expect(args).toContain('sigil-claude-0');
    expect(args).toContain('-e');
    expect(args).toContain('SIGIL_WORKER_ID=claude-0');
    // The worker argv must come AFTER `--` so tmux never re-parses it via a shell.
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.slice(sep + 1)).toEqual(['claude', '--bare', '--model', 'haiku']);
  });

  it('newSession throws on a non-zero exit with stderr', async () => {
    const tmux = createTmux({ runner: fakeRunner({ 'new-session': { code: 1, stderr: 'duplicate session' } }) });
    await expect(tmux.newSession('x', ['claude'])).rejects.toThrow(/duplicate session/);
  });

  it('sendKeys sends a literal payload then Enter (two calls)', async () => {
    const runner = fakeRunner({ 'send-keys': { code: 0 } });
    const tmux = createTmux({ runner });
    await tmux.sendKeys('sigil-claude-0', 'SIGIL_NEXT');

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].args).toEqual(['send-keys', '-t', 'sigil-claude-0', '-l', 'SIGIL_NEXT']);
    expect(runner.calls[1].args).toEqual(['send-keys', '-t', 'sigil-claude-0', 'Enter']);
  });

  it('capturePane returns pane text, and "" on error (never throws)', async () => {
    const ok = createTmux({ runner: fakeRunner({ 'capture-pane': { code: 0, stdout: 'trust the files in this folder?' } }) });
    expect(await ok.capturePane('x')).toMatch(/trust the files/);

    const bad = createTmux({ runner: async () => { throw new Error('no session'); } });
    expect(await bad.capturePane('x')).toBe('');
  });

  it('killSession never throws even when the session is already gone', async () => {
    const tmux = createTmux({ runner: async () => { throw new Error('session not found'); } });
    await expect(tmux.killSession('gone')).resolves.toBeUndefined();
  });

  it('listSessions parses one name per line and filters blanks', async () => {
    const tmux = createTmux({ runner: fakeRunner({ 'list-sessions': { code: 0, stdout: 'sigil-claude-0\nother\n\n' } }) });
    expect(await tmux.listSessions()).toEqual(['sigil-claude-0', 'other']);
  });
});
