# Product

## Register

product

## Users

Developers who use one or more coding agents and want to carry decisions, preferences, and project context across sessions. First-time users choose storage and providers, connect an agent, and check that it can recall a saved memory. Returning users open the dashboard to manage memory, connections, devices, or updates and diagnose problems.

Secondary users: returning developers investigating a specific issue (wrong fact surfaced, hook not firing, search quality degraded).

Job-to-be-done: get Sigil wired and verified in one sitting. Confidence that memory is working, not a second session to figure it out.

## Product Purpose

Sigil is a local-first memory layer for AI coding agents. It stores facts and documents in the built-in database or a Postgres database the user controls. Agents retrieve memories through lifecycle hooks, native plugins, MCP, or the CLI. The capabilities depend on the integration. Hosted providers receive the inputs required for the tasks the user configures them to run.

The dashboard is the control plane: setup wizard, health monitoring, knowledge base inspection, and retrieval debugging. Success looks like: zero config after first-run, no surprises, clear signal when something is broken.

## Brand Personality

Precise, minimal, authoritative. The interface is a serious infrastructure tool, not a productivity app or SaaS platform. No decoration for its own sake. Every element earns its place. Confidence through restraint.

## Anti-references

- **Not Linear or Notion**: avoid rounded corners, friendly whitespace, pastel accents, and the "productivity app" warmth. Sigil is a utility, not a workspace.
- **Not shadcn/Vercel dark**: avoid the polished-neutral, everything-is-a-card aesthetic that reads as "platform product" — Sigil is closer to a serious developer tool than a SaaS dashboard.
- **Not terminal-raw**: not a CLI dump or tmux pane. Structure is appropriate; the goal is density without noise, not rawness for its own sake.

## Design Principles

1. **Clarity earns trust.** The user needs to know Sigil is working at a glance. Status, errors, and health signals must be unambiguous — no hidden states, no soft failures.
2. **The first run is the critical run.** The setup wizard is where most users form their lasting impression. It must be the most polished surface in the product.
3. **Density without noise.** Developer tools need information density, not visual simplicity. Show the data; eliminate chrome that doesn't carry information.
4. **Local-first is the brand.** The fact that nothing leaves the machine is not a footnote — it shapes how the interface should feel: direct, owned, ungated.
5. **Sharp edges, earned.** The sharp-corner aesthetic is a deliberate choice that signals precision and infrastructure, not an absence of design investment.

## Accessibility & Inclusion

WCAG AA. Adequate contrast on all text (≥4.5:1 body, ≥3:1 large text), full keyboard navigation, screen-reader semantics on interactive controls, reduced-motion alternative for every animation.

## User journeys

The first milestone is a save and recall that the user can verify in a fresh agent session. A working installer, a green database check, and an agent config entry are separate checkpoints on that journey.

| Journey | Current path | What the user needs next |
| --- | --- | --- |
| Discover and install | README → `npm i -g` or the shell installer → `~/.sigil/app` → `sigil` | Know the prerequisites up front. Get a persistent command even when setup is deferred. Get the same latest release from npm and Git. |
| Set up and verify | Dashboard or `sigil init` → storage → LLM → embeddings → agent selection → name written as a memory | Start with built-in storage, reuse detected providers with consent, and expose the fix for a failed provider check. Confirm the first save by reading it back in the selected agent. |
| Connect or repair an agent | Dashboard **Agents** or `sigil connect` → detect → write configuration → verify | See which capabilities are configured, which have been observed running, and whether the agent needs a restart or approval. Repair only Sigil-owned entries and preserve other providers and settings. |
| Use and manage memory | Hook or explicit save → recall through a hook, plugin, MCP, or CLI → inspect the source and scope through Knowledge Base, Activity, or `sigil why` | See what was saved or recalled, where it came from, its project and visibility, and how to correct or forget it. Recover from provider failure without confusing it with an empty result. |
| Update or recover | CLI notification → `sigil update` → release checkout, dependency install, daemon restart, database migration and rollback path | Use the same update action from CLI and dashboard. Get a clear final status that reflects the running version, database, and connectors. |
| Add or remove a device | Shared Postgres or an Iroh pairing code and `sigil join` → Devices for listing and revoking | Use one guided pairing path with a clear device role and connection state. Verify a shared memory on the new device and show what happens when the host is unavailable or the device is revoked. |
| Disconnect or leave | Agent-specific uninstall and CLI export, reset, and service commands | Choose whether to disconnect an agent, remove Sigil, or delete stored memory. Make it clear what each operation will preserve. |

The implementation entry points are [the installer](install.sh), [setup service](src/setup/service.js), [agent registry](src/lib/clients/index.js), [dashboard](src/gui/web/app.js), [update handler](src/cli-handlers/update.js), and [pairing command](src/cli-handlers/join.js).

## Proposed release sequence

### 1. Installation and first recall

npm and Git are equal ways in, and both land on one install at `~/.sigil/app`. Only one copy of Sigil may own the daemon and the built-in database, because two copies corrupt it.

| Command | What happens |
|---|---|
| `curl … install.sh \| sh` | Clones the `release` branch into `~/.sigil/app` and starts setup |
| `npm i -g @anmol-srv/sigil`, then `sigil` | The npm `sigil` runs the bundled installer once, then hands every command to `~/.sigil/bin/sigil` |
| `npx @anmol-srv/sigil` | Same as npm, without a global package |
| `npm i -g @anmol-srv/sigil@latest` | Next `sigil` run updates `~/.sigil/app`, restarts the daemon, and migrates the database |
| `sigil update` | Fast-forwards `~/.sigil/app` with the same restart and migration steps |

Every user-facing push to master is released to both channels with one version: an npm publish, the `release` branch, a `vX.Y.Z` tag, and a GitHub Release. The npm package has no runtime dependencies, so it installs in about a second. npm releases before 0.22 ran their own copy of Sigil. The installer and `sigil update` remove them, and upgrading one with `npm i -g` moves its data onto the shared install. [npm entry point](src/lib/npm-door.js) · [Release workflow](.github/workflows/release.yml)

The first increment fixes launcher availability before setup and the handoff to a controlling terminal. Next, make setup resume from the last completed step, test provider detection and recovery, and add a save → new session → recall check. Exercise clean and existing installations on macOS and Linux, then WSL. Report the elapsed time to first recall and the step at which a run fails. [Installer](install.sh) · [Terminal setup](src/cli-handlers/init.js) · [Setup state](src/setup/service.js)

### 2. Agent connectors and lifecycle

Extend the existing registry around detect → connect → verify → repair → disconnect. Track configuration, runtime activity, and available capabilities independently. Match each adapter to the host's event and trust model. Use a stable launcher and a shared memory service below the adapters. T3 Code is a reference for keeping agent-specific setup behind a common surface and supporting CLI and desktop entry points. Hermes is a reference for a first-class memory provider with per-profile lifecycle and a non-blocking write path. [T3 Code](https://github.com/pingdotgg/t3code) · [T3 Code provider implementation](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/provider) · [Hermes memory provider contract](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin)

| Agent | Sigil today | Proposed next check |
| --- | --- | --- |
| Claude Code | Session-start preamble, per-prompt recall, capture at Stop, session cleanup, and MCP | Use as the reference implementation. Verify fresh and resumed sessions, capture deduplication, and fail-open hook timeouts. [Claude Code hook reference](https://code.claude.com/docs/en/hooks) |
| Codex CLI | MCP and instructions in `AGENTS.md` | Test native `SessionStart`, `UserPromptSubmit`, and `Stop` on supported versions. Show pending hook approval and verify a real invocation after review. Preserve the MCP fallback. [Codex hooks](https://developers.openai.com/codex/hooks) |
| Cursor | MCP and a steering rule | Test the scope and context output of `sessionStart`, `beforeSubmitPrompt`, and completion events in the desktop app and CLI before advertising any capability. Keep tool-based recall where a hook cannot inject context. [Cursor hooks](https://cursor.com/docs/agent/hooks) |
| Hermes | Native Python memory provider using profile-scoped recall and capture | Verify the plugin in two active profiles and a background service. Test what happens when the executable is absent or the host is down, and preserve the prior provider on disconnect. [Sigil's Hermes integration](integrations/hermes/README.md) |
| Kiro and other MCP clients | Kiro registration with steering, manual MCP or CLI for others | Verify the tools can read and write from real clients. Extend lifecycle support once the host's contract and the user demand justify it. |

Release criteria are a successful save and recall across two independent sessions, accurate degraded states, and repeatable connect, repair, and disconnect. Add Kiro and other integrations incrementally after Claude Code, Codex CLI, and Cursor have a common set of smoke checks.

### 3. Skills and context injection

Produce a single versioned Sigil skill with host-specific delivery. Reuse injected recall, search on a meaningful context gap, and save explicit durable memory. Give the skill a cheap, read-only health check and make its behavior capability-aware. Keep first-session priming short and scope prompt recall to the active project. Deduplicate session preamble, per-prompt recall, and agent-initiated search. Compare recall quality, cross-project leakage, injected tokens, and warm and cold latency on the same fixtures for each adapter. [Current skill generator](src/lib/clients/skill.js) · [Shared instructions](src/lib/clients/instructions.js) · [Preamble](src/preamble/run.js)

### 4. Updates and rollout

Use a release identifier distinct from the running Git branch. Stage the new build and dependencies, validate migrations and readiness, and make rollback work after interrupted downloads, failed migrations, and failed restarts. Give existing Git installs a supported migration path if distribution changes. Expose the same update operation and progress through CLI and dashboard. Test that existing facts survive and that agents still recall after restart. [Release workflow](.github/workflows/release.yml) · [Current CLI update flow](src/cli-handlers/update.js)

### 5. Dashboard

Build on the existing local dashboard. Make Home answer whether memory works and link each problem to an action. Make Agents and Devices show verification, recent activity, permissions, and repair. Surface update progress and recovery in Settings. Use Knowledge Base for finding, correcting, and forgetting memories, with graph and engine details available for debugging. Run the same core journey through GUI and CLI to check their outcomes agree. [Dashboard application](src/gui/web/app.js) · [Design system](DESIGN.md)

### 6. Multiple devices

Start with one **memory host** and a **connected device** that reads and writes through the host. The existing Iroh lite-follower path proxies a subset of memory calls. Settle pairing persistence, restart behavior, retries, and authorization before broadening the surface. Test save on A → recall on B → save on B → recall on A → revoke B, including host unavailability and visibility restrictions. Keep shared Postgres as an advanced deployment option. Treat offline copies as a separate decision requiring conflict, deletion, and revocation semantics. [Memory client modes](src/memory/client.js) · [Remote operation allowlist](src/daemon/lite-proxy.js)

### 7. Terminology

Apply the vocabulary as each flow changes, then check it across README, CLI help, dashboard, and skills. Use **memory** for what a user saves or recalls, **fact** for a single statement, **document** for an imported source, **project** for where context applies, **agent** for the connected tool, **device** for a machine, and **memory host** for the machine that holds shared memory. Use **connector** in developer docs for the adapter. Keep **pod**, **namespace**, and internal mode identifiers in advanced controls and stable CLI or API contracts. Reserve **sync** for workflows that actually maintain multiple copies.
