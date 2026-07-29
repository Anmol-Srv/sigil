// Codex automatic recall must coexist with other products' hooks. This test
// sandboxes HOME before importing the connector so no real Codex config is
// touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
let codex;
let hooksPath;

const cortexHook = 'node /opt/cortex/user-prompt-submit.js';

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'sigil-codex-hooks-test-'));
  process.env.HOME = sandbox;
  mkdirSync(join(sandbox, '.codex'), { recursive: true });
  hooksPath = join(sandbox, '.codex', 'hooks.json');
  writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cortexHook }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'my-own-tool-hook' }] }],
    },
  }, null, 2));
  codex = await import('./codex-cli.js');
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function commands(config, event) {
  return (config.hooks[event] || []).flatMap((entry) => entry.hooks || []).map((hook) => hook.command);
}

describe('codex-cli UserPromptSubmit integration', () => {
  it('adds one Sigil recall hook, preserves external hooks, and refreshes instructions', async () => {
    await codex.install({});
    await codex.install({});

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const promptCommands = commands(hooks, 'UserPromptSubmit');
    expect(promptCommands).toContain(cortexHook);
    const sigilPromptCommands = promptCommands.filter((command) => command.includes('sigil-hook'));
    expect(sigilPromptCommands).toHaveLength(1);
    expect(sigilPromptCommands[0]).toContain('SIGIL_AGENT=codex');
    expect(commands(hooks, 'PreToolUse')).toEqual(['my-own-tool-hook']);

    const configText = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8');
    expect(configText).toContain('SIGIL_AGENT = "codex"');

    const agents = readFileSync(join(sandbox, '.codex', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('A local UserPromptSubmit hook searches Sigil once');
    expect(agents).not.toContain('This client has **no hooks**');
    expect(await codex.verify({})).toMatchObject({
      installed: true,
      attention: expect.stringContaining('run `/hooks`'),
    });

    // A persisted Codex trust record moves the connector from "configured"
    // to "ready for automatic recall" without changing the hook definition.
    const configPath = join(sandbox, '.codex', 'config.toml');
    const config = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, `${config}\n[hooks.state."${hooksPath}:user_prompt_submit:1:0"]\ntrusted_hash = "sha256:test"\n`);
    expect(await codex.verify({})).toMatchObject({ installed: true, attention: null });

    // Stale generated guidance must be visible without falsely presenting the
    // working MCP/hook connection as disconnected. `sigil update` can then
    // refresh the marker-owned content without rewriting config or trust.
    const agentsPath = join(sandbox, '.codex', 'AGENTS.md');
    const skillPath = join(sandbox, '.codex', 'skills', 'sigil', 'SKILL.md');
    writeFileSync(agentsPath, readFileSync(agentsPath, 'utf8').replace('sigil-instructions:v11', 'sigil-instructions:v10'));
    writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('sigil-skill:v7', 'sigil-skill:v6'));
    expect(await codex.verify({})).toMatchObject({
      installed: true,
      attentionKind: 'outdated',
      attention: expect.stringContaining('sigil update'),
    });
    await codex.refresh({});
    expect(await codex.verify({})).toMatchObject({ installed: true, attention: null });
  });

  it('uninstall removes only Sigil’s hook', async () => {
    await codex.uninstall({});
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(commands(hooks, 'UserPromptSubmit')).toEqual([cortexHook]);
    expect(commands(hooks, 'PreToolUse')).toEqual(['my-own-tool-hook']);
  });

  it('never overwrites a malformed hooks file', async () => {
    const malformed = '{ "hooks": [ }';
    writeFileSync(hooksPath, malformed);
    const { actions } = await codex.install({});
    expect(readFileSync(hooksPath, 'utf8')).toBe(malformed);
    expect(actions.find((action) => action.path === hooksPath)).toMatchObject({ action: 'skip' });
  });
});
