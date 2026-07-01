// Claude session driver — argv leanness, MCP-config shape, nudge, and the
// wedged-dialog healthcheck. LLM_CLI_PATH short-circuits binary resolution so
// these never shell out to find a real `claude`.

import { describe, it, expect, beforeAll } from 'vitest';

import { __setTestConfig } from '../../../../setup/config-store.js';

// config.json is the source of truth — seed cliPath (short-circuits binary
// resolution so these never shell out) + the /clear toggle via the test seam.
beforeAll(() => { __setTestConfig({ llm: { cliPath: '/usr/bin/true', managedSession: { clearBetweenTasks: true } } }); });

const { claudeDriver, NUDGE, CLEAR, SYSTEM_PROMPT } = await import('./claude.js');

describe('claudeDriver.buildLaunch', () => {
  const built = () => claudeDriver.buildLaunch({
    workerId: 'claude-0',
    sourceType: 'claude',
    model: 'claude-haiku-4-5-20251001',
    scratchDir: '/tmp/sigil-sessions',
    workerServer: { command: 'node', args: ['/abs/worker-server.js'] },
  });

  it('launches LEAN: --strict-mcp-config + one --mcp-config, no extra tools; NOT --bare (keeps subscription OAuth auth)', () => {
    const { argv } = built();
    expect(argv).not.toContain('--bare'); // --bare skips OAuth/keychain → breaks subscription workers
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--mcp-config');
    // maps the long model id to the CLI alias
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
  });

  it('primes via --append-system-prompt (survives context resets, never a chat message)', () => {
    const { argv } = built();
    const i = argv.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(0);
    expect(argv[i + 1]).toBe(SYSTEM_PROMPT);
    // The prime must order strict per-task independence (the bleed mitigation).
    expect(SYSTEM_PROMPT).toMatch(/INDEPENDENT/);
    expect(SYSTEM_PROMPT).toMatch(/Never reference prior tasks/);
    expect(SYSTEM_PROMPT).toMatch(/submit_result/);
  });

  it('writes a worker MCP config carrying this worker identity + only the worker server', () => {
    const { files } = built();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/tmp/sigil-sessions/claude-0.mcp.json');
    const cfg = JSON.parse(files[0].content);
    const server = cfg.mcpServers['sigil-worker'];
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['/abs/worker-server.js']);
    expect(server.env.SIGIL_WORKER_ID).toBe('claude-0');
    expect(server.env.SIGIL_SOURCE).toBe('claude');
    // Exactly one MCP server — nothing from the public surface.
    expect(Object.keys(cfg.mcpServers)).toEqual(['sigil-worker']);
  });
});

describe('claudeDriver.nudge', () => {
  const collectingTmux = (sent) => ({ sendKeys: async (name, text) => sent.push({ name, text }) });

  it('/clears the context then sends the trigger (hard per-task isolation)', async () => {
    __setTestConfig({ llm: { managedSession: { clearBetweenTasks: true } } }); // default ON
    const sent = [];
    await claudeDriver.nudge(collectingTmux(sent), 'sigil-claude-0');
    expect(sent).toEqual([
      { name: 'sigil-claude-0', text: CLEAR },
      { name: 'sigil-claude-0', text: NUDGE },
    ]);
  });

  it('clearBetweenTasks=false reverts to prompt-ordering only (no /clear)', async () => {
    __setTestConfig({ llm: { managedSession: { clearBetweenTasks: false } } });
    const sent = [];
    await claudeDriver.nudge(collectingTmux(sent), 'sigil-claude-0');
    expect(sent).toEqual([{ name: 'sigil-claude-0', text: NUDGE }]);
    __setTestConfig({ llm: { managedSession: { clearBetweenTasks: true } } }); // restore
  });
});

describe('claudeDriver.healthcheck', () => {
  const tmuxWithPane = (pane) => ({ capturePane: async () => pane });

  it('flags a blocking trust/permission dialog as unhealthy', async () => {
    const r = await claudeDriver.healthcheck(tmuxWithPane('Do you want to proceed?\n❯ 1. Yes'), 'x');
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/blocking prompt/);
  });

  it('flags a usage/rate-limit wall as unhealthy', async () => {
    expect((await claudeDriver.healthcheck(tmuxWithPane('usage limit reached'), 'x')).healthy).toBe(false);
    expect((await claudeDriver.healthcheck(tmuxWithPane('Please run /login'), 'x')).healthy).toBe(false);
  });

  it('is healthy for an ordinary working pane', async () => {
    const r = await claudeDriver.healthcheck(tmuxWithPane('● Running get_task…'), 'x');
    expect(r.healthy).toBe(true);
    expect(r.reason).toBeNull();
  });
});
