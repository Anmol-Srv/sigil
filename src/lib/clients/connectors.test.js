// Connect → reconnect → disconnect for the agents with native hooks, against
// configs seeded with the user's own servers, hooks and comments. Fully
// offline: $HOME is sandboxed BEFORE the modules load, so the real ~/.codex,
// ~/.cursor and ~/.sigil are never touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';

let SANDBOX;
let codex;
let cursor;
let kiro;
let hermes;
let files;
let status;
let host;

const CODEX_TOML = `# my codex settings
model = "gpt-5" # pinned

[mcp_servers.other]
command = "other-mcp"
`;
const CODEX_HOOKS = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] } };
const CURSOR_HOOKS = { version: 1, hooks: { afterFileEdit: [{ command: './hooks/format.sh' }] } };
const CURSOR_MCP = { mcpServers: { other: { command: 'other-mcp' } } };

const read = (p) => readFileSync(p, 'utf8');

beforeAll(async () => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'sigil-connectors-test-'));
  process.env.HOME = SANDBOX;
  delete process.env.CODEX_HOME;
  mkdirSync(join(SANDBOX, '.codex'), { recursive: true });
  mkdirSync(join(SANDBOX, '.cursor'), { recursive: true });
  writeFileSync(join(SANDBOX, '.codex', 'config.toml'), CODEX_TOML);
  writeFileSync(join(SANDBOX, '.codex', 'hooks.json'), JSON.stringify(CODEX_HOOKS));
  writeFileSync(join(SANDBOX, '.cursor', 'hooks.json'), JSON.stringify(CURSOR_HOOKS));
  writeFileSync(join(SANDBOX, '.cursor', 'mcp.json'), JSON.stringify(CURSOR_MCP));

  codex = await import('./codex-cli.js');
  cursor = await import('./cursor.js');
  kiro = await import('./kiro.js');
  hermes = await import('./hermes.js');
  files = await import('./config-files.js');
  status = await import('./status.js');
  host = await import('../../hooks/host.js');
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

describe('Codex CLI connector', () => {
  it('connects: hooks, MCP entry tagged with the agent, AGENTS.md block — keeping the user\'s config', async () => {
    await codex.install({});
    const toml = read(join(SANDBOX, '.codex', 'config.toml'));
    expect(toml.startsWith(CODEX_TOML.trimEnd())).toBe(true); // comments intact
    expect(TOML.parse(toml).mcp_servers.sigil.env).toEqual({ SIGIL_AGENT: 'codex-cli' });
    expect(TOML.parse(toml).mcp_servers.other.command).toBe('other-mcp');

    const hooks = JSON.parse(read(join(SANDBOX, '.codex', 'hooks.json'))).hooks;
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop[0].hooks[0].command).toBe('notify-me');
    expect(hooks.Stop[1].hooks[0].async).toBeUndefined(); // codex exec skips async Stop hooks
    expect(hooks.Stop[1].hooks[0].command).toMatch(/sigil-hook' stop --agent=codex-cli$/);
    expect(hooks.SessionStart[0].hooks[0].command).toMatch(/session-start --agent=codex-cli$/);
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/user-prompt-submit --agent=codex-cli$/);

    expect(await codex.verify({})).toMatchObject({ installed: true });
  });

  it('reconnecting changes nothing (stable commands keep Codex\'s hook approval)', async () => {
    const { actions } = await codex.install({});
    expect(actions.map((a) => a.action)).toEqual(['skip', 'skip', 'skip']);
  });

  it('a missing piece is reported as partial (needs repair)', async () => {
    const hooksPath = join(SANDBOX, '.codex', 'hooks.json');
    const saved = read(hooksPath);
    writeFileSync(hooksPath, JSON.stringify(CODEX_HOOKS));
    expect(await codex.verify({})).toMatchObject({ installed: false, partial: true });
    writeFileSync(hooksPath, saved);
  });

  it('disconnects back to the user\'s own config', async () => {
    await codex.uninstall({});
    expect(read(join(SANDBOX, '.codex', 'config.toml')).trimEnd()).toBe(CODEX_TOML.trimEnd());
    expect(JSON.parse(read(join(SANDBOX, '.codex', 'hooks.json')))).toEqual(CODEX_HOOKS);
    expect(await codex.verify({})).toMatchObject({ installed: false, partial: false });
  });

  it('refuses to touch an invalid config.toml', async () => {
    const p = join(SANDBOX, '.codex', 'config.toml');
    writeFileSync(p, 'model = = broken');
    const { actions } = await codex.install({});
    expect(actions[0]).toMatchObject({ action: 'skip' });
    expect(read(p)).toBe('model = = broken');
    writeFileSync(p, CODEX_TOML);
  });
});

describe('Cursor connector', () => {
  it('connects: session-start, prompt and stop hooks next to the user\'s hooks', async () => {
    await cursor.install({});
    const file = JSON.parse(read(join(SANDBOX, '.cursor', 'hooks.json')));
    expect(file.version).toBe(1);
    expect(file.hooks.afterFileEdit).toEqual(CURSOR_HOOKS.hooks.afterFileEdit);
    expect(file.hooks.sessionStart[0].command).toMatch(/session-start --agent=cursor$/);
    expect(file.hooks.beforeSubmitPrompt[0].command).toMatch(/user-prompt-submit --agent=cursor$/);
    expect(file.hooks.stop[0].command).toMatch(/stop --agent=cursor$/);

    const mcp = JSON.parse(read(join(SANDBOX, '.cursor', 'mcp.json')));
    expect(mcp.mcpServers.other).toEqual(CURSOR_MCP.mcpServers.other);
    expect(mcp.mcpServers.sigil.env).toEqual({ SIGIL_AGENT: 'cursor' });
    expect(await cursor.verify({})).toMatchObject({ installed: true });
  });

  it('reconnecting changes nothing', async () => {
    const { actions } = await cursor.install({});
    expect(actions.slice(0, 2).map((a) => a.action)).toEqual(['skip', 'skip']);
  });

  it('disconnects, keeping the user\'s hooks and servers', async () => {
    await cursor.uninstall({});
    expect(JSON.parse(read(join(SANDBOX, '.cursor', 'hooks.json')))).toEqual(CURSOR_HOOKS);
    expect(JSON.parse(read(join(SANDBOX, '.cursor', 'mcp.json')))).toEqual(CURSOR_MCP);
    expect(existsSync(join(SANDBOX, '.cursor', 'rules', 'sigil.mdc'))).toBe(false);
  });
});

describe('Kiro connector', () => {
  it('never replaces an mcp.json it cannot parse (it used to start from {} and drop other servers)', async () => {
    const p = join(SANDBOX, '.kiro', 'settings', 'mcp.json');
    mkdirSync(join(SANDBOX, '.kiro', 'settings'), { recursive: true });
    writeFileSync(p, '{ "mcpServers": { "other": { "command": "x" } }, }'); // trailing comma
    const res = await kiro.writeMcpEntry({});
    expect(res.action).toBe('skip');
    expect(read(p)).toContain('"other"');
  });
});

describe('Hermes connector', () => {
  it('a user who picked another memory provider is not "needs repair" (re-sync must not switch them back)', async () => {
    mkdirSync(join(SANDBOX, '.hermes', 'plugins', 'sigil'), { recursive: true });
    writeFileSync(join(SANDBOX, '.hermes', 'plugins', 'sigil', '__init__.py'), '');
    writeFileSync(join(SANDBOX, '.hermes', 'config.yaml'), 'memory:\n  provider: honcho\nmodel: x\n');
    expect(await hermes.verify()).toMatchObject({ installed: false, partial: false });
    writeFileSync(join(SANDBOX, '.hermes', 'config.yaml'), 'memory:\n  provider: sigil\nmodel: x\n');
    rmSync(join(SANDBOX, '.hermes', 'plugins', 'sigil'), { recursive: true, force: true });
    expect(await hermes.verify()).toMatchObject({ installed: false, partial: true });
  });
});

describe('config-files', () => {
  it('only matches Sigil hook commands', () => {
    expect(files.isSigilHookCommand("'/h/.sigil/bin/sigil-hook' stop --agent=cursor")).toBe(true);
    expect(files.isSigilHookCommand('./hooks/format.sh')).toBe(false);
  });
});

describe('hook host adapter', () => {
  it('replies in each agent\'s format', () => {
    expect(host.contextReply('codex-cli', 'SessionStart', 'hi')).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } });
    expect(host.contextReply('cursor', 'SessionStart', 'hi')).toEqual({ additional_context: 'hi' });
    expect(host.contextReply('cursor', 'UserPromptSubmit', 'hi')).toEqual({ continue: true });
    expect(host.contextReply('claude-code', 'UserPromptSubmit')).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  });

  it('reads the agent from argv and ignores unknown names', () => {
    expect(host.agentFromArgv(['node', 'x', '--agent=codex-cli'])).toBe('codex-cli');
    expect(host.agentFromArgv(['node', 'x', '--agent=evil/../x'])).toBe(null);
    expect(host.agentFromArgv(['node', 'x'])).toBe(null);
  });

  it('normalizes Cursor\'s field names', () => {
    expect(host.normalizeInput({ conversation_id: 'c1', workspace_roots: ['/w'] })).toEqual({ sessionId: 'c1', cwd: '/w' });
    expect(host.normalizeInput({ session_id: 's1', cwd: '/p' })).toEqual({ sessionId: 's1', cwd: '/p' });
  });

  it('keeps a prompt for the Stop hook, once', () => {
    host.rememberPrompt('codex-cli', 's1', 'remember that I prefer tabs');
    expect(host.takePrompt('codex-cli', 's1')).toBe('remember that I prefer tabs');
    expect(host.takePrompt('codex-cli', 's1')).toBe(null);
  });

  it('stamps last-seen per channel', () => {
    host.markSeen('codex-cli', 'start', 'mcp');
    const seen = host.lastSeen('codex-cli');
    expect(seen.mcp.event).toBe('start');
    expect(seen.hook).toBeUndefined();
  });
});

describe('connectorState', () => {
  const codexClient = { id: 'codex-cli', firstRunHint: 'approve in /hooks' };
  const at = new Date().toISOString();

  it('configured + a hook has run → working', () => {
    const s = status.connectorState(codexClient, { detected: true, verified: { installed: true } }, { hook: { event: 'prompt', at } });
    expect(s).toMatchObject({ state: 'working', provenAt: at });
  });

  it('Codex with only its MCP server seen is still waiting for hook approval', () => {
    const s = status.connectorState(codexClient, { detected: true, verified: { installed: true } }, { mcp: { event: 'start', at } });
    expect(s).toMatchObject({ state: 'waiting', nextStep: 'approve in /hooks' });
    expect(s.lastSeen.channel).toBe('mcp');
  });

  it('Kiro counts its MCP server as proof', () => {
    const s = status.connectorState({ id: 'kiro' }, { detected: true, verified: { installed: true } }, { mcp: { event: 'start', at } });
    expect(s.state).toBe('working');
  });

  it('partial → needs-repair with the reason; not configured → available / unavailable', () => {
    expect(status.connectorState(codexClient, { detected: true, verified: { installed: false, partial: true, reason: 'missing: hooks' } }, {}))
      .toMatchObject({ state: 'needs-repair', nextStep: 'missing: hooks' });
    expect(status.connectorState(codexClient, { detected: true, verified: { installed: false } }, {}).state).toBe('available');
    expect(status.connectorState(codexClient, { detected: false, verified: { installed: false } }, {}).state).toBe('unavailable');
  });
});

describe('update re-sync (once per version)', () => {
  it('upgrades an older Codex install, leaves agents that aren\'t connected alone, and runs once', async () => {
    const { listClients } = await import('./index.js');
    const { resyncOncePerVersion, resyncConnectedAgents } = await import('./resync.js');
    const codexDir = join(SANDBOX, '.codex');
    // An older Sigil install: MCP entry + AGENTS block, a hand-added Sigil hook,
    // a foreign hook and a comment — but none of the new hooks.
    writeFileSync(join(codexDir, 'config.toml'), `${CODEX_TOML}\n[mcp_servers.sigil]\ncommand = "/old/sigil-mcp"\nargs = []\n`);
    writeFileSync(join(codexDir, 'AGENTS.md'), '<!-- BEGIN sigil -->\nold\n<!-- END sigil -->\n');
    writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: "SIGIL_AGENT=codex '/h/.sigil/bin/sigil-hook' user-prompt-submit" }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }],
      },
    }));
    const cursorHooksBefore = read(join(SANDBOX, '.cursor', 'hooks.json'));
    const hermesBefore = read(join(SANDBOX, '.hermes', 'config.yaml'));
    writeFileSync(join(SANDBOX, '.hermes', 'config.yaml'), 'memory:\n  provider: honcho\nmodel: x\n');
    const kiroBefore = read(join(SANDBOX, '.kiro', 'settings', 'mcp.json'));

    const logs = [];
    const stamp = join(SANDBOX, '.sigil', '.agents-synced-version');
    const clients = await listClients();
    const results = await resyncOncePerVersion('9.9.9', { clients, stamp, log: (m) => logs.push(m) });

    const codexRes = results.find((r) => r.id === 'codex-cli');
    expect(codexRes.changed).toBeGreaterThan(0);
    const hooks = JSON.parse(read(join(codexDir, 'hooks.json'))).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.Stop[0].hooks[0].command).toBe('notify-me'); // foreign hook kept
    expect(hooks.UserPromptSubmit).toHaveLength(1); // the hand-added Sigil hook was replaced, not duplicated
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/--agent=codex-cli$/);
    expect(read(join(codexDir, 'config.toml'))).toContain('# my codex settings');
    expect(await codex.verify({})).toMatchObject({ installed: true });

    // Not connected → untouched.
    expect(results.find((r) => r.id === 'cursor')).toBeUndefined();
    expect(read(join(SANDBOX, '.cursor', 'hooks.json'))).toBe(cursorHooksBefore);
    expect(results.find((r) => r.id === 'hermes')).toBeUndefined();
    expect(read(join(SANDBOX, '.hermes', 'config.yaml'))).toContain('provider: honcho');
    // Kiro's mcp.json is unparseable: skipped, never replaced, and no throw.
    expect(read(join(SANDBOX, '.kiro', 'settings', 'mcp.json'))).toBe(kiroBefore);

    expect(read(stamp).trim()).toBe('9.9.9');
    expect(await resyncOncePerVersion('9.9.9', { clients, stamp })).toBe(null);
    const again = await resyncConnectedAgents({ clients });
    expect(again.find((r) => r.id === 'codex-cli').changed).toBe(0);
    writeFileSync(join(SANDBOX, '.hermes', 'config.yaml'), hermesBefore);
  });
});
