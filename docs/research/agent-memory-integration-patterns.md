# Agent memory integration patterns

Research completed 29 July 2026 against public implementation and integration
documentation for Supermemory and MemSearch, two representative projects in the
`agent-memory` ecosystem.

## The problem to solve

Sigil currently stores facts successfully, but the phrase “Codex pod” suggests
an incorrect product model. An agent is a caller and provenance field, not a
memory boundary. A fact saved by Codex should be visible to Claude when both are
working in the same user or repository scope. The UI should show that it was
written *by Codex*, not imply that it belongs in an isolated Codex database.

## What the compared systems do

| System | Connection pattern | Memory boundary | Capture model | Retrieval model | Cost / risk |
|---|---|---|---|---|---|
| Sigil today | Local MCP, portable skill, one read-only `UserPromptSubmit` hook | Shared local namespace; agent is write provenance | Explicit `remember`, `correct`, and document `ingest` only | One bounded semantic retrieval per prompt where hooks are approved | Low process and data noise; current Codex trust state must be explicit |
| Supermemory | Hosted or self-hosted API, MCP, client plugins and explicit skills | User tag plus project tag derived from Git identity | Incremental automatic capture plus final Stop flush; configurable every N turns | Prompt hook injects matching memories and profile; skills provide search/save/forget/status | Strong continuity, but automatic capture and generated profiles introduce opaque writes and provider dependence |
| MemSearch | Per-client plugin, CLI and skills | Repository-local Markdown source of truth; Milvus is a rebuildable index | SessionStart, UserPromptSubmit and Stop hooks summarize every turn | Skill-driven progressive search, expand, then raw transcript drill-down | High local footprint and lifecycle complexity; Codex setup asks for a bypassed approval/sandbox mode and downloads a local model |

### Supermemory lessons

Supermemory deliberately exposes a small memory surface: save/forget,
recall, identity, and a context prompt. Its Codex plugin pairs a
`UserPromptSubmit` recall hook with a Stop flush, and gives the agent explicit
search, save, forget, profile, and status skills. It scopes memory with stable
user and project container tags, rather than creating a pod per client.

That separation is the useful part. The automatic capture is not.

### MemSearch lessons

MemSearch makes Markdown the editable source of truth and its vector store a
derived index. It installs three Codex hooks: session-start injection,
prompt-time reminder, and Stop-time summarization. Its recall skill performs
progressive disclosure: search, expand a matching section, and optionally read
the original transcript.

The inspectable source and progressive retrieval are useful ideas. Its
every-turn capture, session hooks, model download, full-access Codex launch
instruction, and background maintenance are incompatible with Sigil’s
machine-native reliability goal.

## Decisions for Sigil

1. **No agent pods.** Remove “pod” from user-facing language and future data
   design. Codex, Claude, and custom MCP callers are attributed writers and
   readers of the same scoped memory.
2. **Introduce explicit scopes, not per-agent stores.** Project scope is a
   derived use of Sigil's existing namespace column, not a second scope table
   or database. Derive a project identity from the normalized Git remote, with
   a local-path fallback and an explicit worktree-isolation option. Existing
   facts remain in the current shared/default namespace and are read as a
   compatibility fallback.
3. **Keep two clear interaction planes.** The implicit plane is exactly one
   read-only prompt-time recall. The explicit plane is MCP/skill/CLI actions:
   `search`, `remember`, `correct`, `ingest`, and `status`.
4. **Do not auto-ingest conversations.** No Stop, SessionStart, or
   PostToolUse writes. A user or agent must choose a durable fact or source.
   This preserves the performance and trust properties that motivated Sigil.
5. **Treat hook approval as readiness.** Codex registration, shell
   round-trip, and user trust are distinct states. Only the final state means
   automatic retrieval is live.
6. **Make evidence visible.** The Agents UI needs separate labels for
   connection state, automatic-recall readiness, selected scope, writes by
   agent, and searchable memories in scope. It must never use a green
   “connected” badge as evidence that recall actually happened.

## Implementation sequence

### Phase A — honest connection and activity UI

- Rename any agent “pod” language to **Shared memory scope**.
- Show `MCP connected`, `automatic recall ready` or `approval required`, and
  `writes attributed to this agent` separately.
- Add a hook event record for successful recall injection, containing only
  timestamp, client, scope, result count, and duration. Do not log the prompt
  or returned memory text. This closes the current “did Codex retrieve?”
  observability gap.

**Exit test:** an untrusted Codex hook is visibly not-ready; after `/hooks`
approval, the next prompt produces one recall event. A Codex write appears as
shared memory with Codex provenance, not in a private Codex pod.

#### Implementation record — 29 July 2026

- Replaced pod language with a clear shared-machine scope and separated
  connection, automatic-recall readiness, recall evidence, and durable writer
  provenance in the Agents UI.
- Added a bounded, runtime-only recall ledger (100 events). It records only
  timestamp, agent, namespace, matched/no-match outcome, result count, and
  duration. Search still writes neither a trace row nor a database record.
- Fixed Codex attribution end to end: both the hook and MCP server now set
  `SIGIL_AGENT=codex`, rather than inheriting the generic hook default.
- Made Codex’s explicit hook-trust requirement visible in doctor and the GUI.
  A configured hook remains “approval required” until the user trusts its
  exact command in a new Codex session with `/hooks`.
- Hardened the supervised restart path. On macOS, a service reload now removes
  the launchd job, gracefully releases the exact daemon/PGlite owner, and only
  then starts the replacement. This prevents an orphaned process from making
  launchd report a false-success restart.

**Verification:** unit, integration, lint, build, and live loopback checks
passed. A direct invocation of the installed hook returned the saved Dr Doom
filter decision and recorded only the bounded operational metadata. A live
launchd restart cleanly replaced PID 95089 with PID 98878 and returned a
healthy embedded database. The direct `#agents` GUI route showed a connected
daemon, an explicit Codex approval state, and no browser console errors.

**Final acceptance:** after the user approved Sigil's exact `UserPromptSubmit`
command in a new Codex session, the runtime ledger recorded native Codex recall
attempts (two matches and two precision-correct no-matches). The installed hook
returned the saved Dr Doom filter decision on a direct probe. Later deep doctor
and daemon status checks were healthy; an agent-side "unresponsive" sentence
was therefore stale/transient, not evidence of a current daemon outage.

### Phase B — project scope without a second database

- Reuse the existing indexed `namespace` on facts and chunks; no migration or
  duplicate scope abstraction is needed.
- Keep legacy/default rows in the shared namespace and read them as a fallback.
- Have each Unix-socket client derive a stable, hashed project namespace from
  Git `origin` (or the local Git root when no remote exists). The socket carries
  only the hashed namespace, never a path or repository URL.
- Support `SIGIL_SCOPE=shared` for an opt-out and `SIGIL_SCOPE=worktree` for
  deliberate checkout isolation. An explicit API namespace remains authoritative.
- Search the project tier first, then shared memory. Reuse one query embedding;
  skip the shared tier for an explicit search when the project has already
  filled the requested result budget. Return each fact's namespace as ranking
  evidence.

#### Implementation record — 29 July 2026

- Added one small client-side project resolver plus a daemon-side namespace
  policy. No database, provider, daemon, or agent-pod feature was added.
- `remember` and document `ingest` now write to the active project namespace
  when the caller is in a Git repository; `search` retrieves that project
  before the long-lived shared/default memory. Claude, Codex, CLI, and future
  local socket clients use the same transport contract.
- Preserved all explicit namespace calls unchanged, so custom tools and
  external-database users retain full control. Loopback HTTP has no caller CWD
  and remains explicitly namespaced rather than guessing a project.
- Added transport, resolution, write, document-ingest, and retrieval tests.
  These cover matching clone identities, unrelated repositories, shared and
  worktree choices, one-way socket metadata, project-first retrieval, and one
  query embedding.

**Verification:** 24 focused tests passed; ESLint and production build passed;
the full suite passed 230/230 tests across 56 files. In a live loopback check,
a Codex-attributed project write was retrieved by the Claude-attributed path in
this repository, then removed by its exact fact ID. A final read confirmed the
test marker was gone and shared/default memory remained available. Deep doctor
reported a healthy daemon, PGlite, embedding provider, Claude integration, and
Codex integration.

### Phase C — adapter contract after scope is proven

- Kept one built-in adapter contract: detect, plan, apply, verify, uninstall.
- Added versioned, allowlisted manifests that declare capabilities and owned
  paths. They are discovery metadata, not executable third-party plugins.
- Preserved existing connector behavior while exposing a read-only plan API to
  the daemon/UI contract.
- Added `sigil mcp config` and `sigil mcp test` so a custom MCP-compatible tool
  can connect locally without any Sigil adapter or plugin runtime.
- Updated the shared instructions: project-first retrieval is explicit, and
  generic MCP clients are no longer told to call health-only `prime` as a
  session ritual.

**Verification:** 30 focused adapter, configuration, compatibility, and MCP
HTTP tests passed; ESLint and production build passed; the full suite passed
235/235 tests across 58 files. A live `sigil mcp config --format toml --agent
validation_tool` generated a local stdio entry and `sigil mcp test` completed a
real server initialization plus `status` call. Final deep doctor was fully
green, including Claude and Codex round trips.

**Deliberate boundary:** external adapter execution, filesystem scanning,
marketplaces, remote discovery, and daemon-loaded plugin code remain deferred
until repeated user demand proves generic MCP insufficient.

## Sources

- [Supermemory MCP overview](https://supermemory.ai/docs/supermemory-mcp/mcp)
- [Supermemory Codex integration](https://supermemory.ai/docs/integrations/codex)
- [Supermemory Claude Code plugin](https://github.com/supermemoryai/claude-supermemory)
- [MemSearch repository](https://github.com/zilliztech/memsearch)
- [MemSearch Codex plugin](https://github.com/zilliztech/memsearch/tree/main/plugins/codex)
