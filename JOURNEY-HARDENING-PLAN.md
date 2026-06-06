# Sigil User-Journey Hardening Plan (living doc)

> Purpose: walk Sigil's real user journey step by step. At each step we hunt edge
> cases + bugs in the *actual code*, decide the fix, and log the decision here.
> Build happens after a step's decisions are locked. This doc is the source of truth
> for *what we decided and why*. `SETUP-DESIGN.md` is the strategic north-star;
> this is the road-level driving log that finds the potholes.
>
> Status legend: 🔵 open question (needs user decision) · ✅ decided · 🔨 build item
> (decided, not yet built) · 🐛 confirmed bug · 🧪 verify-in-build · ⏭️ deferred.
>
> Started: 2026-06-05 · Branch: master · Reviewer: Claude (devex-review lenses)
>
> **Progress (2026-06-05):** P0 batch merged to master via **PR #10** (squash `762cf54`):
> B5.1/B5.2 (config-write safety), B1.1/B1.2 (install hardening), B4.1/B4.4 (single onboarding
> flow + dead-config removal) — all with regression tests. Plus a CI fix: the long-red
> `reliability` gate now runs the real 1024-dim embedder (`mxbai-embed-large`, the production
> default) instead of nomic-embed-text (768), so it finally tests the shipping path and passes.
> **Remaining P0: the daemon-routing refactor (Step 6 — scoped below, with live evidence).**

---

## Journey map (order we walk it)

1. **Install** — curl install.sh, npm -g, pnpm -g, npx/pnpx (gated), github install
2. **Preflight / detection** — existing DB, LLM providers, Ollama models, clients
3. **buildWithGui** — display detection, headless/VM/cloud fallback
4. **First-run / zero-config** — daemon boot, embedded store, migrations, smoke test
5. **Client registration** — `sigil connect`, hooks, MCP (stdio shim + HTTP URL)
6. **Steady state** — read/write hot path, timeouts, caches
7. **Upgrade / self-heal** — `sigil upgrade`, version drift, `doctor`, managed blocks
8. **Uninstall / reset** — clean teardown
9. **Extensibility** — onboarding new DB / connector / LLM provider (the meta-goal)

Cross-cutting goal threaded through every step: make adding a new **DB driver**,
**client connector**, or **LLM/embedding provider** a small, well-bounded change
against a stable interface — not a scavenger hunt across the codebase.

---

## STEP 1 — Install

### What the journey looks like today
- Blessed: `curl -fsSL …/install.sh | sh` → detects OS/node/PM → installs `-g` → `exec sigil`.
- Documented alt: `npm install -g @anmol-srv/sigil`.
- `pnpm add -g` supported as fallback inside install.sh (only when npm absent).
- `npx`/`pnpx`/`dlx`/temp → **refused** by `ephemeralPackageRoot()` (src/lib/paths.js) with an install hint.
- GitHub install (`npm i -g github:Anmol-Srv/sigil`) — undocumented, works only via committed `dist/`.

### Findings

🐛 **1.1 pnpm post-`setup` PATH gap.** install.sh:83-92 runs `pnpm setup` then
`pnpm add -g`, but `pnpm setup` writes the new global-bin dir into the shell rc,
not the current piped `sh`. `$PNPM_HOME` is usually unset in that non-interactive
`sh`, so line 88's `[ -n "$PNPM_HOME" ]` is false, PATH is never amended, line 104
`have sigil` fails → user falls into the "not on PATH" warn branch and the first-run
handoff (`exec sigil`) never happens. pnpm-only users get a degraded install.
→ Fix candidate: derive the bin dir explicitly (`pnpm bin -g` after setup) and prepend it.

🐛 **1.2 Stale `dist/` risk on GitHub install.** No `prepare` script, so a git
install ships whatever `dist/` is committed (no build-on-install). Right now `dist/`
has *uncommitted* edits (git status), so master's committed dist can lag src.
GitHub installers would silently get stale code. Tied to decision D1.2 below.

⚠️ **1.3 Spurious-sudo edge (low).** install.sh:71 checks `! -w "$prefix" && ! -w
"$prefix/lib/node_modules"`. Guarded by prefix writability so it rarely misfires,
but on exotic prefixes (symlinked, partially-created) the heuristic can still pick
sudo. Keep an eye; not urgent.

🧪 **1.4 Re-run / upgrade idempotency.** install.sh re-run does `npm i -g pkg@latest`
then `exec sigil`. Need to verify it cleanly upgrades AND re-syncs generated files
(`sigil connect` re-pin) without clobbering user edits. Verify in build.

🔵 **1.5 Proxy / air-gapped.** `curl` + npm registry both need proxy env; no guidance
today. Doc + a `--offline`/tarball story? Lower priority unless enterprise is a target.

### Open decisions (need your call)
- 🔵 **D1.1 Windows scope** — see question.
- 🔵 **D1.2 GitHub install as a supported path?** — see question.
- 🔵 **D1.3 Supply-chain hardening level for the blessed path** — see question.

### Decisions made
- ✅ **D1.1 Windows = WSL-only, fail loud on native.** Support macOS / Linux /
  Windows-via-WSL. install.sh + first-run must *detect native Windows* (no WSL) and
  refuse early with a one-line "install inside WSL" message + link. No native-Windows
  shim/hook work.
- ✅ **D1.2 curl is the single blessed path now; GitHub install deferred (unsupported).**
  Keep `npm install -g` as the underlying mechanism + WSL/security fallback, but don't
  promote it or `github:` installs. No `prepare` script, no build-on-install. Keep
  committing `dist/` (npm tarball needs it; `prepublishOnly` rebuilds it on publish, so
  npm users never get stale dist). Drift footgun is contained because GitHub install is
  out of scope. _(Open: do we also strip `npm i -g` from README prose? Pending user.)_
- ✅ **D1.3 Full supply-chain hardening.** `npm publish --provenance` (OIDC attestation
  via GitHub Actions) + sign `install.sh` itself (publish `.sha256` + minisign/cosign sig,
  document verify-then-run) + SLSA provenance + signed release tarball. Docs show a
  "verify before you run" path. Accept that `curl | sh` can never be fully tamper-proof;
  the verifiable path is the signed-tarball / checksummed route.

### Build items (queued, not yet built)
- ✅ **B1.1 DONE** pnpm PATH gap fixed (install.sh): after `pnpm add -g`, resolve the global
  bin dir from `pnpm bin -g` / `$PNPM_HOME` / known defaults and prepend the one that holds
  `sigil`, so the `have sigil` check + `exec sigil` handoff work for pnpm-only users.
- ✅ **B1.2 DONE** Native-Windows refusal: install.sh now refuses MINGW/MSYS/CYGWIN with the
  WSL pointer; cli.js refuses `process.platform === 'win32'` early (WSL = linux, so this is
  always native Windows). Both point at the WSL install guide. dist rebuilt.
- 🔨 **B1.3** Supply-chain: GH Actions release workflow with `npm publish --provenance`,
  sign install.sh (sha256 + sig), SLSA provenance, signed tarball; README "verify" section.
- 🧪 **B1.4** Verify install.sh re-run upgrades cleanly + re-syncs generated files
  (`sigil connect`) without clobbering user edits (idempotency test).
- ⏭️ **B1.5** Proxy / air-gapped guidance (doc) — deferred unless enterprise becomes a target.

---

## STEP 2 — Preflight / detection

### What the journey looks like today
- DB detection (`setup/db/detect.js`): rich + careful. Probes 5432/5433, distinguishes
  nothing-listening vs auth-required vs foreign-Postgres vs Sigil's-own (via COMMENT
  signature + db/role heuristic), reports embedded(always)/local/docker. Good.
- Embedding step (`steps/embedding.js`) `detect()`: real — Ollama reachability +
  compatible 1024-dim model list (`ollama-admin.js`) + recommended model.
- LLM step (`steps/llm.js`) `detect()`: **static list only.** No Ollama probe, no env-key
  detection, no claude-CLI presence — even though `registry.js` has all of it.
- One step engine (`setup/service.js`, `STEPS=[database,llm,embedding,connectors,identity]`)
  drives BOTH GUI and terminal `sigil init` (`cli-handlers/init.js`). No divergence. Good.

### Findings

🐛 **2.1 LLM-step detection asymmetry.** `steps/llm.js` surfaces no environment
detection while its sibling `steps/embedding.js` does. The runtime `registry.js`
already has `isOllamaReachable()`, `isClaudeCliAvailable()`, and the full key-precedence
ladder, none of it surfaced at the LLM step. User picks blind.

🐛 **2.2 Dead provider-registry contract (the big one).** Every `providers/*.js` exports
`{chat, meta, setup}` and `registry.js` exports `listProvidersForSetup()` — but
`listProvidersForSetup` is never imported and provider `setup()` is never called.
The live path uses the hardcoded `PROVIDERS` array in `steps/llm.js`. So there are TWO
provider definitions; one is dead and actively misleading. Same trap latent for embedders
(`EMBEDDERS` map vs `steps/embedding.js` array).

🔧 **2.3 Provider onboarding cost.** Adding one chat provider touches ~5 files
(`registry.js` map + detect ladder, `steps/llm.js` array + KEYED/NEEDS_MODEL + validate,
`config.js` getter, provider `chat`); ~9 if it also embeds. No single source of truth.

🔧 **2.4 DB-driver detection is Postgres-specific.** `detect.js` hardcodes pg probing.
Adding a non-PG embedded option (sqlite-vec, per SETUP-DESIGN §5 fallback) needs a parallel
detector + driver + step branch. Parallel to 2.2 but for storage. _Deferred to Step 9 /
storage decision (coupled to the still-open PGlite-vs-sqlite-vec benchmark)._

### Open decisions (need your call)
- 🔵 **D2.1 Provider registry unification** — single source of truth, which direction?
- 🔵 **D2.2 Detection surfacing + auto-select UX** at setup.

### Decisions made
- ✅ **D2.1 Provider module = single source of truth (+ stale-code sweep).** Each
  `providers/<name>.js` / `embedders/<name>.js` exports `chat`/`embedBatch` + a rich
  `meta` (id, label, hint, fields, keyed, needsModel, recommended, `detect()`).
  `registry.js` keeps ONE explicit loader map per kind (esbuild-safe). `steps/llm.js`
  and `steps/embedding.js` become thin renderers over the discovered metas; the
  detect precedence ladder is derived from meta, not a hand-written if-chain. DELETE:
  hardcoded `PROVIDERS` arrays in the steps, `KEYED`/`NEEDS_MODEL` sets, and the dead
  `listProvidersForSetup` + unused `meta`/`setup` decoy. Target: add a provider = 1 file
  + 1 map line. _(Working read of "no option + 'remove decoys'"; user can downgrade to B.)_
- ✅ **D2.2 Detect + badge, no pre-select.** Surface env-key presence, Ollama
  reachability + model list, and claude-CLI presence as "detected" badges at the LLM +
  embedding steps. NEVER auto-select — user always makes the explicit choice. Detection
  lives in per-provider `meta.detect()` (consequence of D2.1), so each provider owns its
  own probe.

### Build items (queued)
- 🔨 **B2.1** Define the `meta` contract (id, label, hint, fields[], keyed, needsModel,
  recommended, async `detect()`) and refactor all 5 chat providers + 4 embedders to it.
- 🔨 **B2.2** Reduce `registry.js` to: explicit loader maps + meta-derived detect ladder;
  delete `detectProvider`/`detectEmbeddingProvider` hand-written if-chains in favor of
  meta order + `meta.detect()`.
- 🔨 **B2.3** Make `steps/llm.js` + `steps/embedding.js` thin renderers over discovered
  metas; delete hardcoded arrays + KEYED/NEEDS_MODEL; validation derived from meta.fields.
- 🔨 **B2.4** Delete dead `listProvidersForSetup` + unused provider `setup()` exports.
- 🔨 **B2.5** LLM-step detection badges (env keys, Ollama+models, claude-CLI) via meta.detect().
- 🧪 **B2.6** Test: adding a dummy provider requires exactly 1 file + 1 map line and shows
  up in both GUI and CLI with correct detection. This is the regression guard for the goal.

---

## CROSS-CUTTING WORKSTREAMS (threaded through all steps)

- 🔨 **X1 Stale/dead-code sweep** (from D2.1 note). As we walk each step, flag and remove
  dead code, decoys, and leftover scaffolding — not just the provider `meta`/`setup` decoy.
  Running list:
  - `registry.js` `listProvidersForSetup` (dead) + provider `setup()`/`meta` (currently unused).
  - _(append as found per step)_
- 🔨 **X2 Extensibility-as-a-test.** Each registry we touch (providers, embedders, DB
  drivers, connectors) gets a "1 file + 1 line" regression test so onboarding stays cheap.

---

## STEP 3 — buildWithGui / display detection / headless

### What the journey looks like today
- Zero-arg `sigil` (cli.js ~L95-153): ephemeral guard → start/connect daemon → version-drift
  restart → build GUI URL `http://127.0.0.1:7777/?t=<token>` → if `canOpenBrowser()` open it,
  else print URL + fall back to terminal `runInit` when setup incomplete.
- `canOpenBrowser()` (lib/open-browser.js): false if `SIGIL_HEADLESS`, or linux without
  `DISPLAY`/`WAYLAND_DISPLAY`; otherwise true. `openBrowser()` spawns open/start/xdg-open.
- Daemon GUI binds `127.0.0.1:7777` (loopback, token-gated). `SIGIL_HTTP_HOST` env override exists.

### Findings
🐛 **3.1 Headless detection misses macOS/CI/SSH.** Only `SIGIL_HEADLESS` + linux `DISPLAY`
checked. SSH-into-Mac, macOS CI, CI-with-display → tries to open an invisible browser.
No `$CI`, no `$SSH_CONNECTION`/`$SSH_TTY` check.
🐛 **3.2 `openBrowser()` return value ignored** (cli.js:152). Spawn failure after the
"Opening the dashboard…" message has no fallback (no xdg-open, spawn throws → silent).
🐛 **3.3 Broken + dead `win32` branch.** `spawn('start', …)` doesn't work (cmd builtin) and
native Windows is unsupported (D1.1). → X1 stale-code.
🐛 **3.4 No WSL handling.** WSL now first-class (D1.1) but no WSL detection / Windows-browser
open. WSL users get only the linux DISPLAY heuristic. → D3.2.
🔵 **3.5 Remote VM/cloud unreachable GUI.** Printed URL is `127.0.0.1:7777`, not reachable
from the user's laptop; no SSH port-forward hint. → D3.1.
🔧 **3.6 Missing `--no-browser` flag** (SETUP-DESIGN §10). Only the `SIGIL_HEADLESS` env exists.
⚠️ **3.7 `server.host='0.0.0.0'` :4000** (config.js:150, `src/server.js`). Binds all
interfaces — confirm intent / exposure during first-run step. → X1 / security.

### Open decisions
- 🔵 **D3.1 Remote VM/cloud GUI access strategy.**
- 🔵 **D3.2 WSL browser-open behavior.**

### Decisions made
- ✅ **D3.1 Minimal remote handling.** Keep the GUI bound to `127.0.0.1` (never auto-expose).
  When headless, print "Sigil dashboard running on port 7777" + the URL and let the user
  arrange their own remote access (SSH tunnel, etc.). DO NOT build an SSH-port-forward hint
  feature or a network-bind flag. `SIGIL_HTTP_HOST` remains the existing escape hatch for
  users who want to rebind. Rationale: remote box is genuinely remote; don't over-engineer.
- ✅ **D3.2 Detect WSL, auto-open Windows browser.** Detect WSL via `/proc/version` containing
  "microsoft"; open via `wslview` if present, else `explorer.exe <url>`, else print the URL.
  WSL2 localhost forwarding makes `127.0.0.1` resolve in the Windows browser.

### Build items (queued)
- 🔨 **B3.1** Broaden `canOpenBrowser()`: also headless on `$CI`, `$SSH_CONNECTION`/`$SSH_TTY`
  (incl. darwin so SSH-into-Mac stops opening invisible browsers); keep `SIGIL_HEADLESS`.
- 🔨 **B3.2** Honor `openBrowser()` result; on failure print URL prominently + terminal-init
  fallback when setup incomplete. "Can open" becomes a verified claim, not an assumption.
- 🔨 **B3.3** Remove broken/dead `win32` branch (WSL-only per D1.1).
- 🔨 **B3.4** WSL detection + Windows-browser open (wslview → explorer.exe → print URL).
- 🔨 **B3.5** Headless message: state "dashboard running on port 7777" + URL clearly (D3.1);
  no tunnel hint, no bind flag. Document `SIGIL_HTTP_HOST` as the existing rebind escape hatch.
- ⏭️ **B3.6** `--no-browser` flag — optional/low-priority; `SIGIL_HEADLESS` already covers it.

---

## STEP 4 — First-run / zero-config

### What the journey looks like today
- `sigil setup --quickstart` (cli-handlers/quickstart.js): non-interactive zero-config —
  embedded PGlite, claude-cli LLM (if present, non-fatal if not), Ollama embedder (if
  reachable) or OpenAI via `--embedding-key`, name from `$USER`, identity step writes a
  first memory (full-pipeline smoke test). Routes through the shared step engine.
- Zero-arg `sigil` and the curl installer's `exec sigil` open the WIZARD (GUI or terminal
  init), NOT quickstart.
- DB default in wizard = embedded (recommended). `EMBEDDING_DIM` fixed at 1024.

### Findings
🔵 **4.1 North-star "answer nothing" not wired as default.** Quickstart is opt-in
(`--quickstart`); the install handoff lands users in the wizard. SETUP-DESIGN §2 Tier-0
wanted curl → `sigil` → working memory, zero questions. → D4.1.
🔵 **4.2 No keyless/zero-dependency embedder.** Bare machine (claude-cli, no Ollama, no key)
CANNOT finish zero-config — quickstart stops at embeddings. `embedders/`: ollama, openai,
voyage, openrouter only. Keyless LLM but never keyless embeddings. The single biggest
blocker to the Tier-0 promise. → D4.2.
✅ **4.3 Smoke test is good.** Identity step writes a first memory end-to-end (classify +
embed + DB write). Keep this as the canonical post-setup verification everywhere.
🐛 **4.4 `config.server` 0.0.0.0:4000 is dead config** (no readers; server.js = startMcp
stdio). Resolves 3.7 — not a live exposure. → X1 remove the `server:` block from config.js.
🔧 **4.5 Embedded = single-process** (noted for Step 6). CLI/hook DB ops must route through
the daemon, never open a second PGlite pool. Verify `remember`/hooks at steady-state.

### Open decisions
- 🔵 **D4.1 First-run default path** (wizard vs quickstart vs hybrid) — note D2.2 tension.
- 🔵 **D4.2 Zero-config embeddings on a bare machine** (bundle local embedder / auto-Ollama / accept requirement).

### Decisions made
- ✅ **D4.1 Remove quickstart; one native onboarding flow for all.** Delete the quickstart
  concept entirely — no "QuickStart vs Advanced", no `--quickstart`. A SINGLE native flow
  (the `setup/service.js` step engine) serves every entry point: zero-arg `sigil`, terminal
  `sigil init`, and the GUI dashboard. Simpler, consistent with D2.2 (user chooses), and
  removes a whole code path. Net: the wizard IS onboarding for everyone.
- ✅ **D4.2 Accept the embedder requirement; nail the wizard UX.** No bundled model, no
  auto-installer. At the embedding step, detect "no embedder" and present two clean inline
  paths — `ollama serve` (free/local, exact command) or paste a cloud key — resumable once
  fixed. "For all" = one flow for all entry points (D4.1), NOT a promise of zero-dependency
  on a bare machine. Honest framing required in docs (B4.3).

### Build items (queued)
- ✅ **B4.1 DONE** Removed quickstart: deleted `cli-handlers/quickstart.js` + the chooser;
  `sigil setup` now aliases the single native flow (`runInit`); zero-arg `sigil` opens the same
  step engine in the GUI. Fixed the not-configured DB error (referenced a removed `sigil
  quickstart`). dist rebuilt. (PR #10)
- 🔨 **B4.2** Keep the identity-step full-pipeline smoke test (4.3) as the canonical
  post-setup verification in the single flow.
- 🔨 **B4.3** Embedding-step "no embedder" branch: detect early, inline two-path guidance
  (ollama serve / paste key), resumable. Also make README/marketing honest that embeddings
  need Ollama-or-a-key (LLM can be keyless; embedder cannot).
- ✅ **B4.4 DONE** Removed dead `config.server` block (0.0.0.0:4000) from config.js — verified
  zero readers. dist rebuilt. (X1)

---

## STEP 5 — Client registration (connect, hooks, MCP)

### What the journey looks like today
- `clients/index.js`: LIVE registry. Each `clients/<name>.js` exports `{meta, detect, install,
  uninstall, verify}`; load-time validation; `listClients()` feeds the picker. 5 clients:
  claude-code, cursor, codex-cli, kiro, hermes. Adding one = drop a file + 1 line.
- claude-code: merges 4 hooks into settings.json (via stable `sigil-hook` shim) + @import line
  in CLAUDE.md + shared instructions. cursor: mcp.json merge + rules/sigil.mdc. codex: TOML
  config.toml [mcp_servers.sigil] + AGENTS.md (marker-delimited). MCP also over HTTP (daemon).
- `safeWrite`: backs up to `.sigil.bak` once before first write.

### Findings
🐛 **5.1 (CRITICAL) claude-code wipes a malformed settings.json.** `mergeHooks`
(claude-code.js:76-80) does `catch { settings = {} }` on JSON.parse failure → writes a fresh
file with ONLY sigil hooks, destroying all other user settings/hooks. Silent; `.sigil.bak`
is one-time and may be stale. cursor.js + codex-cli.js already do this RIGHT (ENOENT → fresh;
parse error → don't touch + report). claude-code is the lone offender on the most critical file.
🐛 **5.2 Non-atomic writes.** `safeWrite` = bare `writeFile` (no temp+rename). Crash mid-write
corrupts the file; `.bak` is manual recovery, not prevention.
🧪 **5.3 Terminal hook install unverified.** connectors step `apply()` is a no-op (GUI connects
via `connectConnector` RPC). Confirm terminal `sigil init` actually calls client `install()` so
CLI-only users aren't left without hooks.
✅ **5.4 Client registry is the gold standard** (live, validated, drop-a-file). Connector
onboarding (one of the 3 extensibility axes) is ALREADY in good shape. D2.1 copies this exact
contract for providers/embedders.

### Decisions made
- ✅ **D5.1 No fork — fix to match the codebase's own convention.** Malformed-config policy is
  already settled by cursor/codex ("don't touch, report"); claude-code must follow it. Atomicity
  + terminal-install verification are straight fixes. Nothing for the user to choose here.

### Build items (queued)
- ✅ **B5.1 DONE** Fixed `claude-code.js mergeHooks` malformed-JSON handling (matches
  cursor/codex: ENOENT → fresh; parse error → skip + report, never write). Regression test:
  `src/lib/clients/claude-code.malformed.test.js` (asserts byte-identical file + skip action).
- ✅ **B5.2 DONE** `safeWrite` now atomic (same-dir temp + `rename`, temp cleaned on failure),
  used by every client/config writer. Regression test: `src/lib/safe-write.test.js`. dist rebuilt.
- 🧪 **B5.3** Verify + ensure terminal `sigil init` installs hooks for selected clients.
- 🔨 **B5.4** Audit all client writers + generated files for atomic-write + don't-touch-malformed
  consistency (managed-block discipline is mostly present; this closes the gaps). Partially
  supersedes SETUP-DESIGN §9 "pending".

---

## STEP 6 — Steady-state hot path (read/write hooks, timeouts, caches)

### What the journey looks like today  *(revised after scoping, 2026-06-05)*
- The daemon ALREADY exposes 27 RPCs (`rpc-registry.js` + `handlers/`), incl. the full hot path:
  `search` (wraps `memory/search/hybrid.js`), `remember` (write + AUDM), `ingestDoc`,
  `refreshContext`, `listFacts`, `forgetFact`, `status`. **Server side is essentially built.**
- Agent-facing CLI verbs ALREADY route through the daemon: `remember`→`client.call('remember')`,
  `search`→`client.call('search')`, `context`, `facts`→`listFacts`. **Already thin clients.**
- The **4 HOOKS do NOT** — they import `cortex`/`hybrid` directly and open their own pool per turn.
- A few **COLD CLI verbs also open `cortex` directly**: `doctor` (SELECT 1, cli.js:585), `export`,
  `why`, `namespace`, … `cortex.js` itself has no daemon proxy.
- `factoryReset` already runs inside the daemon (Step 8). Read hook runs `route:true` (an LLM call)
  synchronously in-budget; LLM response cache is in-memory only.

### Findings
🐛 **6.1 (CRITICAL — PROVEN LIVE) Embedded + hooks = PGlite WASM abort.** The read hook opens
`cortex` directly; in embedded mode the daemon owns the single PGlite engine, so the hook aborts.
**EVIDENCE:** `~/.sigil/.hook-errors.log` holds **130 read-hook failures this session**
(10:01→13:32), all the same pod/trace/fact query chain ending in `Aborted(). Build with
-sASSERTIONS` — PGlite's WASM engine aborting on the second opener. **Memory auto-injection
(Sigil's core value) has been silently broken the entire session.** Not theoretical; the live
failure mode. → D6.1.
🟢 **6.2 (CORRECTED) Hot CLI verbs already route through the daemon.** remember/search/context/
facts are already thin RPC clients — no churn, no conflict there. The conflict is limited to
(a) the 4 hooks and (b) the cold direct-cortex verbs. Scope is smaller than first feared.
🐛 **6.5 (NEW) `doctor` opens cortex directly** (cli.js:585 `cortexDb.raw('SELECT 1')`) → the
SAME double-open conflict in embedded mode: the tool you run to diagnose can itself trigger the
WASM abort. Doctor must read DB health via the daemon `status` RPC, not its own pool.
🔧 **6.3 Synchronous LLM routing in the read budget** (`route:true` on the 10s path). Unchanged.
🔧 **6.4 LLM response cache is in-memory only** (lost on daemon restart). Unchanged.
✅ **6.6 (FIXED) Embedded DB write corruption — serial sequence desync.** Surfaced once the read
hook stopped aborting: the WRITE path failed with `duplicate key value violates "chunk_pkey"`
because a serial sequence (e.g. `chunk_id_seq`) sat BEHIND its column's `max(id)`, so the next
auto-id INSERT collided. Confirmed by direct inspection (chunk ids {1,2} with the sequence behind
them). **Fix:** `resyncSequences(knex)` in `db/migrate.js` — catalog-driven `setval` of every
serial/identity sequence to `MAX(id)`; runs after EVERY migration (`migrateEmbedded` +
`runMigrationsOn`) so a fresh provision/reset self-heals, and is exposed in-place as
`sigil repair --sequences` (`repair.sequences` RPC) for a live DB without a reset. Idempotent,
no-op on a healthy DB. Regression test: `src/db/migrate.test.js` (desync → heal → insert succeeds).
After the fix the chunk insert succeeds ("1 chunks created"). Also seen: the abort contention had
degraded the *daemon's own* engine (a wedged daemon timed out; a fresh one searches in &lt;0.5s).
_Residual (separate, NOT 6.6): on cold Ollama models the fact-save/AUDM step can be slow (a 30s
`remember` timeout observed) — a write-path latency item for Phase B/E, not corruption. The 15
earlier `--bg` saves were lost when the daemon was wedged; that data is gone (re-save if needed)._

### Decisions made
- ✅ **D6.1 Route all hook + remaining direct-cortex access through the daemon (sole DB owner).**
  Refined after recon: the server RPCs + hot CLI verbs are DONE. The work is the 4 hooks + the
  cold direct-cortex verbs (doctor/export/why/namespace) + a double-open guard. Embedded and
  Postgres collapse to ONE access path; fixes 6.1, removes remaining churn, enables 6.3/6.4.

### DAEMON-ROUTING REFACTOR — SCOPE (P0 #2)
> Goal: in embedded mode, **only the daemon process opens `cortex`**. Everything else is a thin
> RPC client. Phased so the proven-broken read hook is fixed first.

**Already done (verified):** 27 daemon RPCs (search/remember/ingestDoc/refreshContext/listFacts/
status/…); CLI remember/search/context/facts route through the daemon; factoryReset runs in-daemon.

**Phase A — read hook (highest priority; fixes the 130 live aborts).**
- Rewrite `hooks/user-prompt-submit.js`: stdin → `connectOrStartDaemon()` →
  `client.call('search', { query, namespaces, route:true, podScope:'auto', applyFloor:true,
  ctx:{cwd,sessionId} })` → format `additionalContext` from the response. Delete the direct
  `hybrid.js`/`cortex` import + `cortexDb.destroy()` calls. The `search` RPC already takes these
  exact params — minimal server work.
- Degradation: bound connect+call to the 10s budget; on timeout/no-daemon, emit empty
  `additionalContext` (skip injection). NEVER block the prompt, NEVER open cortex as a fallback.

**Phase B — write hooks (stop, post-tool-use, session-end).**
- Route classify+write through the `remember`/`ingestDoc` RPCs instead of importing the store/cortex.
  Preserve `--bg`/spool semantics client-side; verify `.stop-spool.jsonl` drains via the daemon.

**Phase C — cold direct-cortex verbs + doctor.**
- `doctor`: swap the direct `cortex SELECT 1` for the daemon `status` RPC (DB health + provider +
  embedding-lock + spool). Safe in embedded mode and richer.
- `export`, `why`, `namespace`, etc.: route via an RPC (add a thin handler where missing) or gate
  behind the Phase-D guard.

**Phase D — the guard (make the failure impossible).**
- In `cortex.js getPool()`: if `driver.kind==='embedded'` AND a daemon is running AND this process
  is NOT the daemon → throw a clear redirect-to-RPC error. Mirrors the quickstart single-process
  guard. Belt-and-suspenders so no future code reintroduces the 6.1 abort.

**Phase E — latency wins (enabled by A–D; can follow).**
- Daemon fast-path read search (vector+keyword in-budget; defer LLM route/expand; cache for next
  turn). (6.3 / §8)  ·  Daemon-owned persistent LLM-response cache (mirror `embedding_cache`). (6.4)

**Risks / watch:** daemon cold-start on a session's first hook vs the 10s budget → must skip-inject,
not hang; `connectOrStartDaemon` must be fast+quiet from a hook; confirm pod-scope/trace writes now
happen server-side; ensure auto-spawn from a hook doesn't itself race two daemons.

### Build items (queued)
- ✅ **B6.1 DONE (Phase A)** read hook → `search` RPC client; budget-bounded (8s call / 9s overall)
  skip-inject degradation; force-exit after stdout flush; records only `SigilRpcError` (timeouts +
  transient = soft skip, keeping the error budget meaningful). Added `expand` passthrough to the
  `search` RPC handler to preserve behavior. **VALIDATED live:** zero WASM aborts across runs (the
  130-abort failure mode is gone); warm daemon search &lt;0.5s; graceful empty on a scoped miss; 136
  unit tests green; dist rebuilt. _(Positive-injection demo blocked by separate DB corruption — 6.6.)_
- 🟡 **B6.2 Phase B (stop hook DONE; 2 to go).** `stop.js` now routes the write through the daemon
  `ingestTurn` RPC (new handler: resolves active pods + `saveFacts` server-side; same path the spool
  replayer uses). classify stays hook-side (LLM, no DB); cursor + spool stay file-side; `cortexDb`
  import dropped. Budget-bounded (20s) → spool on failure (AUDM dedups any replay). Validated: daemon
  log shows ingestTurn running server-side, no WASM abort, no chunk_pkey collision. STILL TODO:
  `post-tool-use.js` + `session-end.js` (both still open cortex directly).
- ✅ **6.6 hardened further:** `resyncSequences` now also runs on **daemon boot** (embedded-only,
  in `probeDbHealth`) so a desync self-heals on every start — not just on provision/`repair`. Server
  Postgres is skipped (doesn't desync, may be shared).
- 🔨 **B6.3** Phase C: `doctor` → `status` RPC; route/guard remaining cold direct-cortex verbs.
- 🔨 **B6.4** Phase D: embedded single-process guard in `cortex.js getPool()`.
- 🔨 **B6.5** Phase E: daemon fast-path read search (defer LLM expand). (§8)
- 🔨 **B6.6** Phase E: daemon-owned persistent LLM-response cache.
- 🧪 **B6.7** Regression: an embedded-mode read-hook invocation against a running daemon must NOT
  abort (assert no new WASM-abort line in `.hook-errors.log`).

---

## STEP 7 — Upgrade / self-heal

### What the journey looks like today
- No `sigil upgrade`; no update-notifier. Upgrade = manual `npm i -g` / curl.
- Version-drift auto-restart exists but ONLY in zero-arg `sigil` (cli.js:110): daemon.version
  != PKG_VERSION → `restartDaemon`. Hooks/other CLI verbs don't trigger it.
- `INSTRUCTIONS_VERSION=4` + `<!-- sigil-instructions:vN -->` marker → instructions re-sync on
  bump; `sigil connect` re-merges other generated files (manual).
- `sigil doctor [--deep]` exists.

### Findings
🔧 **7.1 No one-command upgrade.** Manual npm/curl; no pkg-update + daemon-restart + connect-resync. → §9.
🔧 **7.2 No update awareness.** No "vX→vY available" nudge. → D7.2 (network/privacy fork).
🐛 **7.3 Drift restart not centralized.** Only zero-arg `sigil` restarts a stale daemon. Post-D6.1,
hooks route through the daemon, so a stale daemon serves stale hook logic until bare `sigil` runs.
Move the drift check into the shared connect path. → D7.1 (hot-path restart policy).
✅ **7.4 Managed-block versioning foundation is solid** (instructions marker + connect re-merge).

### Open decisions
- 🔵 **D7.1 Hook behavior on daemon version drift** (auto-restart vs degrade-and-defer).
- 🔵 **D7.2 Update notifications** (update-notifier network check vs opt-in vs none).

### Decisions made
- ✅ **D7.1 Auto-restart everywhere, hooks included.** Any client connect that detects daemon
  drift triggers `restartDaemon`. Accepted tradeoff: the first post-upgrade message may degrade.
  HARDENING refinement: the read hook must bound the restart to its budget and SKIP injection that
  turn rather than hard-timeout the user's prompt — degrade, never hang.
- ✅ **D7.2 update-notifier on by default.** Daily throttled npm-registry version check on CLI
  use, printing "vX→vY, run sigil upgrade". Honor `NO_UPDATE_NOTIFIER` + CI opt-out. CONSEQUENCE:
  reword README "No cloud, no telemetry" to stay honest ("no telemetry; optional version check,
  disable via env").

### Build items (queued)
- 🔨 **B7.1** `sigil upgrade`: `npm i -g @anmol-srv/sigil@latest` → restart daemon → run
  `connect` to re-sync managed blocks. One command. (§9)
- 🔨 **B7.2** Wire update-notifier (daily throttled check; `NO_UPDATE_NOTIFIER`/CI opt-out).
  Reword README privacy claim to match (B7.4).
- 🔨 **B7.3** Centralize version-drift detection in `connectOrStartDaemon`; auto-restart for all
  clients (D7.1). Read hook: skip-inject if restart would exceed the 10s budget (never hang).
- 🔨 **B7.4** README privacy-claim accuracy pass (also covers B4.3 honesty about embeddings).

---

## STEP 8 — Uninstall / reset

### What the journey looks like today
- `sigil uninstall [--dry-run]`: multiselect detected clients → each client's registry
  `uninstall()` removes MCP entry (others preserved), instructions/rules file, hooks, AND the
  `@import` line. Leaves data. `reset.js`: `disconnectAllClients`, `wipeMemoryData`,
  `dropConfiguredDatabase` (docker container+volume / local drop / external left intact),
  `factoryReset` (runs IN the daemon; embedded → rm PGlite dir).

### Findings
✅ **8.1 @import line IS removed on uninstall** (claude-code.js regex + safeWrite) — no dangling import.
✅ **8.2 Embedded reset is daemon-owned** (factoryReset runs in the daemon) — no double-open. Same
D6.1 principle already applied. (Verify the CLI `sigil reset` path also routes through the daemon — B8.2.)
✅ **8.3 Registry-driven + external-DB-safe.** uninstall/reset symmetric with install via the registry.
🔧 **8.4 Fragmented full teardown + residue.** Complete removal = uninstall + `reset --wipe-db` +
`npm uninstall -g` + `rm ~/.sigil`; `.sigil.bak` snapshots linger in `~/.claude`. Minor.

### Decisions made
- ✅ **D8.1 No fork — green step.** Keep the uninstall(clients) / reset(data) split. Just improve
  teardown completeness + docs + verify reset routing. Nothing for the user to choose.

### Build items (queued)
- 🔨 **B8.1** Document a single "completely remove Sigil" recipe; optionally offer `.sigil.bak`
  cleanup at the end of uninstall (keep by default — they're the user's pre-sigil snapshots).
- 🧪 **B8.2** Verify CLI `sigil reset` routes through the daemon (D6.1 consistency) in embedded mode.

---

## STEP 9 — Extensibility synthesis (the meta-goal)

### What the journey looks like today
- `db/drivers/index.js` `selectDriver()`: 3 drivers — embedded (ClientPGlite), url (PG URL,
  `classifyProvider`), local (PG fields). ALL Postgres: `client:'pg'`/PGlite dialect, same
  schema/migrations/`vector(1024)`. The "driver" = how to connect to a Postgres, not which engine.
- Fail-loud when unconfigured (no silent localhost:5432). external/url providers classified.

### Findings
✅ **9.1 DB layer is intentionally Postgres-only.** PGlite = Postgres-in-WASM, so embedded ↔
server share one SQL/migration/vector path. This is the design strength (per §5), not a gap.
🔧 **9.2 Two different "add a DB" asks.** (a) Another Postgres-compatible target (Neon/Supabase/
RDS/Render/Railway/etc.) = already near-trivial via URL classification. (b) A non-Postgres engine
(sqlite-vec/LanceDB) = fork the data layer (dialect + migrations + vector type + query builder).
🔧 **9.3 2.4 reframed.** The PG-specific detector is correct; detection should be per-*provider*
(local PG vs URL vs managed), not per-engine.
🔧 **9.4 Three axes, three maturities.** clients = gold registry ✅; providers = D2.1 to match;
DB = D9.1 scope below. UNIFY all three onto one registry contract (meta + funcs + load-time
validation + `listX()`).

### Open decisions
- 🔵 **D9.1 DB extensibility scope** (Postgres-compatible-only + formalize provider registry /
  pluggable non-PG engine layer / status quo).

### Decisions made
- ✅ **D9.1 Postgres-compatible only; formalize a provider registry; decline non-PG.** "Postgres
  is the substrate" is a deliberate, documented boundary. Adding a managed PG backend = a small
  registry entry (URL pattern + label + `detect()`), mirroring clients/providers. Non-PG engines
  (sqlite-vec/LanceDB) are explicitly out of scope, with the rationale documented (preserves the
  embedded↔server seamless data copy and one SQL/migration/vector path). Reframes 2.4: detection
  is per-provider, not per-engine.

### Build items (queued)
- 🔨 **B9.1** `db/providers/` registry: embedded + neon/supabase/rds/render/railway/generic-url,
  each = URL pattern + label + optional `detect()`. `selectDriver` consults it. Per-provider detection.
- 🔨 **X3 (capstone)** Unify clients + providers + embedders + DB providers onto ONE documented
  registry contract (meta + functions + load-validation + `listX()`), modeled on `clients/index.js`.
  One "add an X" mental model across all extensibility axes. Single EXTENDING.md doc + the
  "1 file + 1 line" regression tests (X2).

---

## SYNTHESIS — decisions ledger + build sequence

### Decisions ledger (one line each)
- **D1.1** Windows = WSL-only; native Windows refused early.
- **D1.2** curl is the one blessed install path; GitHub install deferred; npm -g kept as mechanism.
- **D1.3** Full supply-chain: npm provenance + signed install.sh + SLSA + signed tarball.
- **D2.1** Provider module = single source of truth (rich meta + one loader map); kill the decoy.
- **D2.2** Detect + badge, never auto-select; detection lives in `meta.detect()`.
- **D3.1** Minimal remote: keep 127.0.0.1, print port/URL, user tunnels themselves.
- **D3.2** Detect WSL → auto-open Windows browser (wslview → explorer.exe → print).
- **D4.1** Remove quickstart; ONE native onboarding flow for all entry points.
- **D4.2** Accept the embedder requirement; nail the wizard "no embedder" UX; no bundled model.
- **D5.1** No fork; fix claude-code to match cursor/codex (don't touch malformed; atomic writes).
- **D6.1** Route ALL hook + DB-touching CLI access through the daemon (sole DB owner).
- **D7.1** Auto-restart on drift everywhere (hooks included); read hook skip-injects, never hangs.
- **D7.2** update-notifier on by default (env opt-out); reword README privacy claim.
- **D8.1** No fork; keep uninstall(clients)/reset(data) split; improve teardown completeness.
- **D9.1** Postgres-compatible only; formalize a PG-provider registry; decline non-PG engines.

### Master build sequence (build afterward)

**P0 — correctness & safety (do first):**
0. ✅ **DONE (PR #10)** — reliability CI gate fixed (real 1024-dim embedder); B5.1/B5.2/B1.1/B1.2/
   B4.1/B4.4 merged. See progress header.
1. ✅ **DONE (PR #10)** — **B5.1** malformed-`settings.json` wipe fix + **B5.2** atomic writes,
   with regression tests. _(B5.4 broad writer audit still queued.)_
2. **B6.1–B6.7** Daemon-routing refactor (D6.1) — scoped in Step 6 as **Phases A–E**: read hook →
   write hooks → doctor + cold verbs → double-open guard → fast-path + LLM cache. **Phase A is the
   priority** (fixes 130 PROVEN WASM aborts in `.hook-errors.log`). Server RPCs + hot CLI verbs are
   already done, so this is smaller than first scoped — mostly client-side hook rewrites + a guard.
3. ✅ **B4.1 DONE** Remove quickstart → single native flow (D4.1) + ✅ **B4.4 DONE** delete dead
   `config.server`. _(B4.3 "no embedder" UX polish still queued.)_
4. ✅ **DONE** — **B1.1** pnpm PATH fix + **B1.2** native-Windows refusal (D1.1).

**P1 — extensibility & DX:**
5. **B2.1–B2.6** provider/embedder registry unification + detection badges (D2.1/D2.2).
6. **B9.1 + X3** DB-provider registry + capstone: unify all 3 axes on one contract + EXTENDING.md.
7. **B3.1–B3.5** headless/WSL/macOS-SSH browser fixes (D3.1/D3.2).
8. **B7.1–B7.3** `sigil upgrade` + centralized drift auto-restart + update-notifier (D7.1/D7.2).
9. **B1.3** supply-chain: provenance + signed install.sh + SLSA + signed tarball (D1.3). _(CI, parallelizable)_

**P2 — polish, docs, cleanup:**
10. **X1** stale-code sweep (dead `listProvidersForSetup` + provider `meta`/`setup`, win32 branch, etc.).
11. **B7.4 / B4.3** README honesty pass (privacy claim + embedder requirement).
12. **B8.1–B8.2** teardown completeness + verify reset routing.
13. **X2** extensibility "1 file + 1 line" regression tests.

### Cross-cutting (every PR)
- **X1** remove dead code as found · **X2** add the registry regression test when touching an axis.
