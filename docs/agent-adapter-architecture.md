# Sigil Agent Adapters: Compatibility and Extension Plan

**Status:** bounded internal registry and generic MCP path implemented 29 July
2026; external adapters deliberately deferred.

## Decision

Build a **bounded, manifest-driven agent-adapter registry**. Do not build a
general-purpose in-process plugin runtime, marketplace, or auto-installer.

This is deliberately less ambitious than an OpenClaw-style plugin platform.
Sigil's users want a reliable machine service that keeps memory available; they
do not want a second ecosystem that can start arbitrary processes, corrupt
agent configuration, or make diagnosis harder.

An agent adapter has one job: safely connect one external tool to Sigil, then
prove that it works. The memory engine, MCP service, database, and lifecycle
remain Sigil core.

## Implementation checkpoint — 29 July 2026

- Built-in adapters now have an allowlisted, versioned manifest declaring
  capabilities and the Sigil-owned paths each adapter may modify. The adapter
  module remains bundled code; Sigil does not discover or execute arbitrary
  files as “plugins.”
- The registry exposes a shared `detect → plan → apply → verify → uninstall`
  contract. `plan` runs the existing adapter code in dry-run mode, so its
  actions remain aligned with the actual writer; legacy `install` stays as a
  compatibility alias while callers migrate.
- `listConnectors` returns capability and adapter-version metadata, and exposes
  a read-only `planConnector` RPC for future preview UI. Existing Connect and
  Disconnect flows retain their tested behavior.
- `sigil update` now uses the lockfile (`npm ci`) and refreshes only
  Sigil-owned instructions, rules, and skills for adapters that already verify
  as installed. It intentionally does not rewrite Codex TOML, MCP entries, or
  hook trust during an upgrade.
- Any MCP-compatible tool can now use `sigil mcp config --format json|toml
  --agent <id>` and verify it with `sigil mcp test`. This is the supported
  extension path today.

The right stop condition holds: generic MCP solves custom-tool connection with
zero new daemon workers. Do not start the guarded external-adapter phase until
several concrete tools require behavior that MCP cannot provide.

## Why change the current implementation

The existing `src/lib/clients/index.js` registry is static. A new integration
requires both a module and a manual entry in `CLIENTS`. Its useful connector
contract already exists (`detect`, `install`, `uninstall`, `verify`), and the
Claude/Codex implementations show good safety instincts: marker ownership,
stable launcher shims, and post-install verification.

It is nevertheless too implicit and too weak for a changing agent landscape:

- capabilities are only prose in `meta.hint`; the GUI cannot say precisely
  what a connection provides;
- there is no schema/version/migration story for an integration;
- there is no one generic route for an MCP-compatible custom tool;
- Codex configuration is serialized directly with `@iarna/toml`, which loses
  a user's comments even when keys survive; and
- a connector cannot clearly distinguish detected, connected, stale,
  incompatible, and unknown states.

## Current compatibility findings (27 July 2026)

This is a local-runtime audit, not an assertion about every released version.

| Tool | Installed version | Verified current surface | Sigil's correct role |
| --- | --- | --- | --- |
| Codex CLI | `0.141.0` | `codex mcp add` supports local stdio commands and streamable HTTP URLs; stable user-level `UserPromptSubmit` hooks are configured in `~/.codex/hooks.json`; `codex plugin` and `codex doctor --json` exist. | Use MCP for explicit memory actions plus one fail-safe `UserPromptSubmit` hook for automatic recall. Do not use `PreToolUse`: it repeats work within a turn. Preserve unrelated hooks and require Codex's normal hook trust review. |
| Claude Code | `2.1.198` | Supports MCP config, `UserPromptSubmit` hooks, skills, and explicit plugin directories/URLs. | Use the targeted `UserPromptSubmit` hook only for automatic recall. Keep it fail-safe and do not add capture hooks or agent-session generation. Offer MCP too, so Claude works without hooks/safe mode. |

The installed Claude runtime confirms the surfaces Sigil relies on; its hook
shape is also consistent with Anthropic's plugin development material. The
installed Codex runtime confirms a managed MCP command, URL support, plugins,
and a machine-readable doctor. We must still run compatibility fixtures against
the latest supported versions in CI before changing either adapter.

### Product truth to keep visible

There is no honest way to promise identical recall behavior across agents:

- **Claude Code:** targeted automatic recall is possible through one
  `UserPromptSubmit` hook.
- **Codex:** use the stable `UserPromptSubmit` hook for one bounded, read-only
  recall before the model responds. Keep MCP for explicit writes and targeted
  drill-down searches; do not add capture or per-tool hooks.
- **Any MCP client:** it can use Sigil immediately through a documented stdio
  or loopback HTTP MCP connection. It does not need a Sigil adapter.

The Agents screen should show these capabilities explicitly: **MCP tools**,
**automatic recall**, **instruction file**, and **health checked**.

For Codex, automatic recall has a separate readiness state: **configured,
awaiting approval**. A direct command round-trip only shows that Sigil's hook
can run; Codex will run it in a real session only after the user has trusted
the exact command in `/hooks`. `sigil doctor` and the Agents screen must name
that action instead of presenting a green deep check as proof of live recall.

### Portable memory skill

Sigil ships one small `sigil` skill to Claude and Codex rather than writing
separate, drifting agent prompts. The skill follows the useful gstack pattern:
a preamble establishes only the state needed for the requested workflow, clear
state-to-action branches, and a concise completion contract. For Sigil this
means reading injected recall and calling `status`; it deliberately does not
run `doctor`, generation, ingestion, or writes during normal preflight.

The skill prefers MCP `status`, `search`, `remember`, and `correct` when a
client exposes them, with the stable `~/.sigil/bin/sigil` CLI as its fallback.
This is the portable contract for future adapters. It must never add a
per-tool hook, automatic capture, private session manager, or another memory
index.

## Proposed model

```text
                    ┌──────────────────────────┐
                    │ Sigil core                │
                    │ daemon · DB · MCP · CLI   │
                    └────────────┬─────────────┘
                                 │
             ┌───────────────────┴───────────────────┐
             │ Agent-adapter host                     │
             │ discover · plan · apply · verify       │
             │ backup · ownership · doctor            │
             └───────────────┬────────────────────────┘
              built-in       │          explicit local extension
     ┌────────────────────────┴──────┐   ┌────────────┴─────────────┐
     │ Claude Code  Codex  Cursor ... │   │ ~/.sigil/adapters/<id>/  │
     │ versioned manifests + code     │   │ manifest + isolated tool │
     └───────────────────────────────┘   └──────────────────────────┘
```

### Adapter contract

Every built-in adapter implements the current operations plus explicit
metadata. The host owns orchestration; adapters never directly alter daemon
lifecycle or database state.

```ts
type AdapterManifest = {
  id: string;
  version: string;
  displayName: string;
  minSigilVersion: string;
  capabilities: {
    mcp: boolean;
    automaticRecall: boolean;
    instructions: boolean;
    healthCheck: boolean;
  };
  ownership: { markers: string[]; allowedPaths: string[] };
};

type Adapter = {
  manifest: AdapterManifest;
  detect(): Promise<Detection>;
  plan(): Promise<ChangePlan>;       // no write
  apply(plan: ChangePlan): Promise<ApplyResult>;
  verify({ deep?: boolean }): Promise<Verification>;
  uninstall(): Promise<ApplyResult>;
};
```

`ChangePlan` is essential. Before touching a client config, Sigil can show the
exact paths, configuration keys, backup location, capability gained, and a
reversible operation. The GUI invokes the same plan API as `sigil connect`.

### Discovery rules

1. **Built-ins first.** Ship Claude Code and Codex as adapter directories in
   the Sigil package. A manifest is discovered from an allowlisted built-in
   directory. No behavior changes in this phase.
2. **Generic MCP before custom adapters.** `sigil mcp config` prints validated
   stdio and loopback HTTP snippets; `sigil mcp test` performs a real
   `initialize`/tool call. This is how a custom tool calls Sigil.
3. **External adapters only after demand is proven.** A user installs an
   adapter explicitly into `~/.sigil/adapters/<id>/`; Sigil never scans random
   directories, fetches plugins in the background, or executes a manifest
   simply because it is present.
4. **No in-process third-party code.** The initial extension protocol is a
   versioned JSON request/response command run out of process, with a small
   allowlisted capability set: `detect`, `plan`, `apply`, `verify`, and
   `uninstall`. A future declarative patch language is preferable to allowing
   arbitrary JavaScript in the daemon.

External adapters must declare writable config paths, commands, network need,
and support status. Sigil presents those permissions, creates backups, offers
`--dry-run`, and records the exact adapter version in its health report.

## What we will not build

- a plugin marketplace;
- automatic remote plugin discovery or updates;
- arbitrary code loaded into the daemon process;
- generic hooks for every agent;
- an agent abstraction that pretends all integrations have feature parity;
- LLM-powered connection setup.

Those would make a reliability product less reliable. A marketplace becomes
reasonable only after at least three independent external adapters have shown
the same manifest, safety, and lifecycle needs.

## Implementation sequence

### Phase 0 — compatibility audit and fixtures

**Goal:** establish exact contracts before refactoring.

1. Create version-pinned fixtures for Claude and Codex config files, including
   comments, unrelated MCP servers, invalid configuration, stale shims, safe
   mode, and absent binaries.
2. Add a compatibility matrix to CI: supported versions, observed config
   shape, transport, recall mode, install command, and deep verification.
3. Audit current Codex config behavior. If `codex mcp add/remove` is safer than
   TOML round-tripping, use it; otherwise preserve comments through a targeted
   text edit rather than serializing the whole file.
4. Add an explicit compatibility status: `supported`, `needs-reconnect`,
   `unsupported-version`, or `unknown-version`.

**Exit test:** each fixture completes install → verify → reinstall → uninstall
without changing user-owned content. The assertion must be byte-level outside
Sigil-owned blocks/keys.

### Phase 1 — internal adapter registry

**Goal:** replace hard-coded registration, with zero new third-party execution.

1. Move each current connector into an adapter directory with its manifest.
2. Make discovery load only allowlisted bundled manifests.
3. Convert `install` into `plan` then `apply`; retain a compatibility wrapper
   temporarily so setup, CLI, GUI, and reset cannot diverge.
4. Give every adapter a stable ownership record and schema version.
5. Add contract tests shared by every adapter: idempotence, unrelated-config
   preservation, stale install detection, rollback on failed verify, and deep
   round-trip where available.

**Exit test:** `sigil init`, `sigil connect`, GUI connect, `sigil doctor`, and
`sigil reset` produce exactly the prior observable behavior for Claude and
Codex.

### Phase 2 — honest Agents UX and recovery

**Goal:** make the connection surface understandable to entry-level engineers.

1. Replace vague hints with a compact capability matrix and a plain-English
   explanation of what happens on each prompt.
2. Show one primary action per state: Connect, Repair, Reconnect, Disconnect,
   or View setup plan.
3. Make all configuration mutations preflighted and backed up. A failed deep
   verify must restore the prior config automatically.
4. Extend `sigil doctor --json` with adapter id/version, detected tool version,
   capabilities, config paths, and exact repair command.

**Exit test:** a new user can tell, without reading docs, whether memory is
automatic or MCP-assisted and how to repair it.

### Phase 3 — generic custom-tool connection

**Goal:** support custom tools without inventing a plugin.

1. Add `sigil mcp config --transport stdio|http`.
2. Add `sigil mcp test` to validate the generated configuration against the
   live daemon.
3. Publish one short local recipe for JSON, TOML, and manual command clients.
4. Keep loopback HTTP opt-in and authenticated; keep stdio as the portable
   default.

**Exit test:** a small unknown MCP client can call `prime`, `search`, and
`remember` using only Sigil's generated config snippet.

### Phase 4 — guarded external adapters (only if demand proves it)

Start only when users cannot connect at least three valuable tools through
generic MCP and maintainers are repeatedly adding similar first-party adapters.

1. Specify `sigil.adapter.json` and JSON Schema.
2. Add explicit `sigil adapter install <path>`, `list`, `inspect`, `test`, and
   `remove`; never `npm install` from the adapter host.
3. Execute adapter commands outside the daemon with timeouts, bounded output,
   and no inherited secret environment by default.
4. Require declared writable paths and validate every planned change against
   them.
5. Add signed releases or a user trust confirmation before any remote source is
   considered.

**Exit test:** a malicious adapter cannot alter files outside its declared
paths, stall the daemon, or make a hidden network call without user consent.

## Success metrics and stop conditions

Measure before and after each phase:

- connection success and deep-verification success by adapter/version;
- `doctor` false-green and false-red rate;
- median time from `sigil init` to a usable agent connection;
- recovery success after a client upgrade or moved Sigil install;
- number of users who need a custom adapter after being offered generic MCP;
- daemon memory/CPU impact: adapters must add **zero** resident daemon workers.

Stop Phase 4 if custom MCP configuration solves the majority of requests, or
if adapter safety/maintenance outweighs a concrete integration's user demand.

## Immediate recommendation

Start Phases 0 and 1 with **Codex and Claude only**. Do not migrate Cursor,
Kiro, or Hermes until the internal contract has proven its worth. The first
Codex work now uses one versioned `UserPromptSubmit` compatibility fixture for
automatic recall; the next correction is deciding whether its own `codex mcp`
CLI can replace Sigil's comment-destroying TOML serialization. The first Claude
correction should be an MCP fallback and a versioned hook compatibility test,
not more hooks.

## Sources checked

- Local runtime: `codex-cli 0.141.0` — `codex mcp add --help`, `codex plugin
  --help`, `codex doctor --help`, and stable `UserPromptSubmit` hook schemas.
- Local runtime: `Claude Code 2.1.198` — `claude --help`.
- [Anthropic Claude Code plugin/MCP development material](https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev), queried for MCP, hooks, and plugin structure on 27 July 2026.
- [OpenAI Codex documentation](https://developers.openai.com/codex/) and the
  installed Codex CLI help, checked 27 July 2026. The official manual documents
  the user-level `~/.codex/hooks.json` surface, `UserPromptSubmit`, and the
  `additionalContext` output shape used by Sigil.
