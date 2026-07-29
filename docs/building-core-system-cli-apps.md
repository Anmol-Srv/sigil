# Building Core System Applications: A Manual

### CLI-driven, daemon-backed developer tools — architecture, lifecycle, config, and the discipline of teardown

> **Scope.** This manual is about a specific class of software: a **long-lived background process (a daemon)** that owns shared machine resources (a database, a network endpoint, caches, worker pools), fronted by a **thin CLI** and integrated into other tools via **hooks / plugins / connectors**. Think `docker`, `gh`, `tailscaled`, `colima`, `ollama`, `git-lfs` — and the reference implementation this manual is built on, **Sigil** (a persistent-memory daemon for AI coding agents).
>
> Every architectural claim here is grounded in working code, cited as `file:line`. The patterns are extracted from a real system that learned most of these lessons the hard way (corruption incidents, respawn storms, orphaned daemons, the works). Where an industry standard exists, it is cited.

---

## Table of Contents

1. [Mental model: what a "core system app" actually is](#1-mental-model)
2. [The architecture: daemon as sole owner, CLI as thin client](#2-architecture)
3. [Process lifecycle: start, detect, stop, supervise](#3-process-lifecycle)
4. [Graceful shutdown and crash policy](#4-graceful-shutdown)
5. [The lifecycle command suite: a design taxonomy](#5-command-taxonomy)
6. [Uninstall and reset, done right (the cardinal discipline)](#6-uninstall-and-reset)
7. [Configuration management](#7-configuration)
8. [State and data ownership](#8-state-ownership)
9. [Installation, updates, and integrity](#9-install-update)
10. [Integrations: connectors, hooks, and plugins](#10-integrations)
11. [Observability and self-healing](#11-observability)
12. [Security](#12-security)
13. [CLI UX principles](#13-cli-ux)
14. [Testing lifecycle code](#14-testing)
15. [Anti-patterns: a field guide (with the real bug as case study)](#15-anti-patterns)
16. [Checklists](#16-checklists)
17. [References](#17-references)

---

<a name="1-mental-model"></a>
## 1. Mental model: what a "core system app" actually is

A core system app is not one program. It is a **federation of cooperating parts** with very different lifetimes and trust levels:

| Part | Lifetime | Owns | Example in Sigil |
|---|---|---|---|
| **Daemon** | long-lived (days) | the DB pool, the network endpoint, worker pools, caches | `sigild` (`src/daemon/index.js`) |
| **CLI** | milliseconds, per-invocation | nothing — it's a client | `sigil <verb>` (`src/cli.js`) |
| **Hooks / plugins** | per-event, spawned by *other* programs | nothing — they call the daemon | `sigil-hook` in Claude Code's `settings.json` |
| **Supervisor** | the OS | restarting the daemon | launchd / systemd / Task Scheduler |
| **Config + state** | persists across all of the above | the user's truth | `~/.sigil/` |

The single most important consequence: **the daemon's lifetime is decoupled from the CLI's lifetime, and the supervisor's lifetime is decoupled from both.** Almost every hard bug in this class of software comes from forgetting this. The user in the field report uninstalled the *app* (CLI + files) and was baffled the *daemon* kept running — because those are three different lifetimes and the uninstall only addressed one.

> **Why a daemon at all?** Because some resources are *single-owner*. An embedded database can only be opened by one process. A TCP port can only be bound once. A warm pool of subprocess workers is expensive to recreate per call. The daemon exists to be the *one* process that holds these, so that N short-lived CLI/hook invocations can share them cheaply. This is the entire justification — if you don't have a single-owner resource, you may not need a daemon at all.

---

<a name="2-architecture"></a>
## 2. The architecture: daemon as sole owner, CLI as thin client

### 2.1 The daemon owns; everyone else borrows

The defining rule: **shared, single-owner resources live in exactly one process, and everything else talks to that process over IPC.** In Sigil, the embedded Postgres (PGlite) is single-process by construction; the daemon is the only legitimate owner, and every CLI verb, hook, and MCP client routes its DB access *through* the daemon.

This is enforced, not merely documented:

```js
// src/db/pglite-adapter.js — only the daemon may open the embedded engine
async function assertEmbeddedOpenable() {
  if (process.env.SIGIL_DAEMON_PROCESS === '1') return; // legit owner
  const pid = await detectRunningDaemon();
  if (!pid) return; // no daemon → safe to open solo (CLI provision/migrate)
  throw new Error(`Sigil's daemon (pid ${pid}) holds the built-in database — it is single-process...`);
}
```

**Principle:** a single-owner invariant must be *enforced in code at the moment of acquisition*, with a clear error, not left as a comment. The env-var tag (`SIGIL_DAEMON_PROCESS=1`) marks the blessed owner; everyone else checks for a live daemon and refuses.

### 2.2 IPC choice: Unix socket + an exclusive TCP port

Sigil uses two transports, deliberately:

- **A Unix domain socket** (`~/.sigil/sock`) for CLI↔daemon RPC — fast, local, filesystem-permissioned.
- **An exclusive TCP port** for the GUI/HTTP and, critically, as the **race-proof singleton lock** (see §3.2).

The TCP bind is the linchpin. A filesystem socket can be stale-left after a crash; a PID file can name a recycled PID. But `bind()` on a TCP port is an *exclusive kernel operation* — only one process can hold it, and it can't be silently stolen. That makes "does anyone answer `/healthz` on the port?" the most authoritative liveness signal in the whole system (`src/daemon/lifecycle.js:75-91`).

### 2.3 The CLI is a thin client that auto-starts the daemon

The CLI does almost nothing itself. It connects to the daemon and issues an RPC; if no daemon is running, it spawns one (§3.3). The explicit `sigil daemon start` command and the implicit "first CLI call" path **deliberately share the same spawn machinery** so behavior can't diverge:

```js
// src/cli-handlers/daemon.js:109 — explicit start reuses auto-spawn
// "Reuse the auto-spawn machinery so behaviour matches implicit start on first CLI call."
await connectOrStartDaemon({ quiet: true })
```

**Principle:** there should be exactly one code path that starts the daemon. Two paths *will* drift, and the drift will only show up under concurrency.

### 2.4 Lazy everything, so import is always safe

Because the same modules are imported by the daemon, the CLI, the hooks, the migrator, and the tests, **module import must never have side effects** like opening a connection. Sigil builds the DB handle as a lazy `Proxy` that defers driver selection to the first actual query:

```js
// src/db/cortex.js — the pool is built lazily, never at module load
let pool = null;
function getPool() { if (pool) return pool; pool = knex({ /* ... */ }); return pool; }
const cortexDb = new Proxy(function () {}, {
  apply: (_t, _s, args) => getPool()(...args),
  get:   (_t, prop)     => getPool()[prop],
});
```

**Principle:** every module should be importable by a process that has *no* configuration and *no* daemon, without throwing. The "not configured" error belongs at query time, not import time — otherwise the daemon can't even boot far enough to serve its own setup UI.

---

<a name="3-process-lifecycle"></a>
## 3. Process lifecycle: start, detect, stop, supervise

This is the heart of the manual. Get this wrong and you ship the orphaned-daemon bug.

### 3.1 Detecting a running daemon: three signals, in priority order

"Is a PID alive?" is **not** "is my daemon running?" After a reboot the OS recycles PID numbers; a stale PID file can name an unrelated process (or another user's, which surfaces as `EPERM`). Sigil corroborates with three signals (`src/daemon/lifecycle.js`):

```js
// 1. POSIX null-signal liveness — exists + signalable?
export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; } // EPERM = alive but foreign
}

// 2 + 3. Corroborate: fresh heartbeat whose pid matches, OR /healthz answers
export async function detectRunningDaemon() {
  const pid = await readPidFile();
  if (pid && isPidAlive(pid)) {
    const hb = await readHeartbeat();
    const fresh = hb && (Date.now() - hb.ts) < HEARTBEAT_STALE_MS; // 45s = 3 missed beats
    if (fresh && hb.pid === pid) return pid;
  }
  if (await isHttpDaemonServing()) return (await readHeartbeatPid()) ?? 'unknown';
  if (pid) await removePidFile();                 // genuinely stale → clean up
  if (existsSync(SIGIL_DAEMON_SOCK)) await removeSocketFile();
  return null;
}
```

The hierarchy of trust:

1. **Heartbeat file** (`{pid, ts, version}` rewritten every 15s) whose `pid` matches the PID file and whose `ts` is fresh → it's *our* daemon.
2. **`/healthz` on the exclusive TCP port** → authoritative even if the PID file is wrong, because the port can't be stolen.
3. Neither → declare the slot free and **clean up the stale PID/socket files** so a fresh start can succeed.

**Principle:** liveness detection must distinguish "some process owns this PID" from "*my* daemon is serving." Use an application-specific heartbeat plus an unspoofable resource (the bound port) as corroboration. Always clean up stale artifacts when you conclude "not running."

### 3.2 The TCP port as the real singleton lock

The daemon claims the exclusive port **before** writing the PID file or binding the socket. If the port is taken, a competing daemon exits with *zero side effects* — no clobbered PID file, no stolen socket:

```js
// src/daemon/index.js — claim the port FIRST; lose the race cleanly
try { http = await startHttpServer({ registry, log, config }); }
catch (err) {
  if (err.code === 'EADDRINUSE') {
    log(`http port ${config.http.port} already in use — another daemon is serving; exiting`);
    process.exit(0);  // peer won; we leave its files untouched
  }
}
await writePidFile();
const socket = await startSocketServer({ registry, log });
```

**Principle:** pick one resource whose acquisition is *atomic and exclusive at the OS level* (a TCP bind, an `O_EXCL` file create) and make it the singleton gate. PID files and sockets are bookkeeping, not locks.

### 3.3 Auto-spawn: a three-branch decision, behind a spawn lock

When the CLI needs the daemon, it doesn't blindly fork. It distinguishes three states (`src/clients/auto-spawn.js`):

```js
export async function connectOrStartDaemon({ quiet = false } = {}) {
  if (await canConnect()) return openSocketClient(opts);     // 1. responsive → use it
  const existing = await detectRunningDaemon();
  if (existing) {                                            // 2. alive but busy
    if (await waitForResponsive(BUSY_GRACE_MS)) return openSocketClient(opts);
    throw new SigilDaemonBusyError(existing);                //    don't spawn a competitor
  }
  await spawnDaemonSerialized({ quiet });                    // 3. absent → spawn (locked)
  await waitForReady();
  return openSocketClient(opts);
}
```

Two details that prevent disasters:

- **Branch 2 throws instead of spawning.** A daemon that's alive-but-slow must not get a forked competitor that would just print "already running" and die. Surfacing a typed `SigilDaemonBusyError` is the difference between "wait a moment" and a *respawn storm* where every concurrent CLI/hook invocation forks its own node process.
- **Spawning is serialized by an `O_EXCL` lock with a TTL and dead-holder steal** (`auto-spawn.js`). The atomic `openSync(path, 'wx')` is the lock; a holder older than the TTL or whose PID is dead gets its lock stolen, so a crashed spawner can never deadlock all future starts.

The detached spawn redirects stdio to the log (not `/dev/null`) so a boot crash leaves a trail, then `unref()`s so the CLI can exit:

```js
// src/clients/auto-spawn.js — detached, logged, unref'd
const out = openSync(SIGIL_DAEMON_LOG, 'a');
const child = spawn(process.execPath, [daemonScript], {
  detached: true, stdio: ['ignore', out, out], env: { ...process.env, SIGIL_DAEMON_AUTOSPAWN: '1' },
});
child.unref();
```

Readiness is polled with exponential backoff (25ms→400ms), and **on timeout the last lines of the daemon log are inlined into the error** so the user sees *why* it failed, not just "timed out."

> ⚠️ **Auto-spawn is a respawn vector.** This is the subtle trap. Because *any* hook or CLI call resurrects the daemon, killing the daemon is not the same as keeping it down. If a hook is still wired into another tool, the next event respawns the daemon. Teardown (§6) must remove the *triggers*, not just the process.

### 3.4 Stopping: SIGTERM → grace → SIGKILL, and supervisor-awareness

A correct stop is a *sequence*, and it must know whether a supervisor will resurrect the process:

```js
// src/cli-handlers/daemon.js — the full stop discipline
async function cmdStop() {
  const pid = await readPidFile();
  if (!pid || !isPidAlive(pid)) { console.log('sigild is not running'); return; }

  // If an always-up service is installed, a plain SIGTERM gets resurrected.
  if (await isServiceInstalled()) {
    console.log('sigild is managed by the always-up service — it will auto-restart after a stop.');
    console.log('To keep it down, run:  sigil service stop');
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;                      // grace for DB flush
  while (Date.now() < deadline && isPidAlive(pid)) await delay(50);
  if (isPidAlive(pid)) {
    console.error(`sigild (pid ${pid}) did not exit within 10s — sending SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
```

Three things every `stop` must do:

1. **Check the supervisor first.** Under launchd `KeepAlive` or systemd `Restart=always`, a SIGTERM is pointless — the supervisor relaunches instantly. Detect it and tell the user the *real* lever (`sigil service stop`).
2. **Give a grace window before SIGKILL.** The daemon needs time to flush (checkpoint the DB, write a snapshot). SIGKILL during a flush can tear a checkpoint and corrupt the store. 10s here is calibrated to the DB flush cost.
3. **Verify and escalate.** Wait, re-check liveness, then force-kill. A `stop` that returns while the process is still alive is a lie.

### 3.5 Supervisor integration: one interface, three OS backends

The OS supervisor is what makes a daemon "always up" across reboots. Sigil abstracts launchd / systemd / Task Scheduler behind a single interface with lazy platform dispatch (`src/supervisor/index.js`), so no caller has platform conditionals:

```js
function backendLoader() {
  switch (process.platform) {
    case 'darwin': return () => import('./launchd.js');
    case 'linux':  return () => import('./systemd.js');
    case 'win32':  return () => import('./windows.js');
  }
}
```

The restart policies and their gotchas:

| OS | Mechanism | "Always up" key | Crash back-off | How to *truly* stop |
|---|---|---|---|---|
| macOS | launchd plist | `KeepAlive=true` + `RunAtLoad` | `ThrottleInterval=10` | `launchctl bootout` (a SIGTERM is respawned) |
| Linux | systemd `--user` unit | `Restart=always` + `loginctl enable-linger` | `RestartSec=2` | `systemctl --user stop` |
| Windows | Scheduled Task | `ONLOGON` | *(none — documented gap)* | task delete; auto-spawn covers in-session |

Two non-obvious requirements:

- **Crash back-off is mandatory.** `ThrottleInterval` (launchd) / `RestartSec` (systemd) prevent a daemon that crashes *on boot* from being relaunched as fast as it dies — which pins a CPU core and floods the log. Without it, a boot-crash loop looks exactly like the runaway-daemon symptom from the field report.
- **Installing the service must first kill any unsupervised daemon** (`src/supervisor/index.js`), or the new supervised instance fails its "already running" check and `KeepAlive` restarts it forever.

```xml
<!-- src/supervisor/launchd.js — back-off is not optional -->
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>  <!-- 10s between respawns -->
<key>EnvironmentVariables</key>
<dict><key>SIGIL_SUPERVISED</key><string>1</string></dict>  <!-- so the daemon knows -->
```

> The `SIGIL_SUPERVISED=1` env var is how the daemon and the `stop` command know they're under supervision — that's what powers the "use `sigil service stop`" warning in §3.4.

---

<a name="4-graceful-shutdown"></a>
## 4. Graceful shutdown and crash policy

### 4.1 Idempotent signal handling

Install handlers for SIGTERM, SIGINT, SIGHUP, gated by a single `firing` flag so a double-signal (supervisor SIGTERM + user Ctrl-C) can't run cleanup twice:

```js
// src/daemon/lifecycle.js — fire once, ever
export function installShutdownHooks(shutdown) {
  let firing = false;
  const fire = async (signal) => {
    if (firing) return; firing = true;
    try { await shutdown(signal); }
    finally { process.exit(0); }
  };
  process.on('SIGTERM', () => fire('SIGTERM'));
  process.on('SIGINT',  () => fire('SIGINT'));
  process.on('SIGHUP',  () => fire('SIGHUP'));
}
```

### 4.2 Flush durable state before exiting — with a deadline

The shutdown callback must persist anything in-flight *and* must not hang forever doing it:

```js
// src/daemon/index.js — checkpoint + snapshot, raced against a deadline
clearInterval(heartbeatTimer);
rmSync(SIGIL_HEARTBEAT, { force: true });
await socket.close();
if (cfg.db.mode === 'embedded') {
  await cortexDb.raw('CHECKPOINT');                          // flush WAL
  await Promise.race([
    takeSnapshot({ reason: 'shutdown', log }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('snapshot timed out')), 8_000)),
  ]);
}
await cortexDb.destroy();
await removePidFile();
```

**Principle:** graceful shutdown is "flush, then exit" — but every flush gets a timeout, because a slow disk must not turn a clean stop into a hang. (And recall from §3.4 that the CLI's 10s SIGKILL deadline is the outer bound on this 8s snapshot.)

### 4.3 Crash policy: rejection vs. exception are different

```js
// src/daemon/index.js — two failures, two policies
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason?.stack || reason}`);
  // keep running — one stray rejection must not kill a shared daemon
});
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err?.stack || err}`);
  process.exit(1); // heap state suspect — let the supervisor restart a clean copy
});
```

A shared daemon serving many clients must **survive a single handler's unhandled rejection** (log and continue). But a synchronous uncaught exception leaves the V8 heap in an undefined state — the only safe move is to exit and let the supervisor (or the next auto-spawn) bring up a clean process.

---

<a name="5-command-taxonomy"></a>
## 5. The lifecycle command suite: a design taxonomy

Every core system app converges on roughly the same verb set. Designing them as a *coherent family* — with consistent reversibility and blast-radius semantics — is what separates a tool that feels trustworthy from one that surprises you.

| Verb | Reversible? | Blast radius | Confirm? | Notes |
|---|---|---|---|---|
| `init` / `setup` | yes | writes config + connects tools | no (interactive) | idempotent; re-runnable |
| `daemon start/stop/restart` | yes | the process only | no | supervisor-aware |
| `daemon status` | read-only | none | no | liveness ≠ health (§5.2) |
| `daemon logs` | read-only | none | no | `--follow` to tail |
| `service start/stop/install` | yes | the supervisor unit | no | the "keep it down" lever |
| `update` | yes (auto-revert) | code + schema | no | lockstep code/schema (§9) |
| `doctor` | read-only | none | no | diagnose, don't fix |
| **`uninstall`** | yes | *integrations only* | optional | **does NOT touch data/daemon** |
| **`reset`** | **NO** | *everything* | **YES** | full teardown; `--yes` to script |

Two design rules make this family coherent:

### 5.1 Reversibility dictates confirmation and naming

`uninstall` (remove our hooks from other tools — reversible by re-running `init`) and `reset` (drop the database, delete the home dir — irreversible) are **different verbs** precisely because they have different blast radii. Conflating them is how users lose data. Sigil's `uninstall` help says so explicitly:

```
sigil uninstall — Remove Sigil's entries from AI clients
Sigil's own data — ~/.sigil/, the database, stored facts — is NOT touched.
Use 'sigil reset' for a full wipe.
```
*(`src/cli.js:494`)*

### 5.2 Liveness and health are separate dimensions

`status` must report *two* independent facts: is the process up (PID alive + socket answers `ping`), and is the underlying resource healthy (a real `SELECT 1`). A daemon can be fully "running" with a dead embedded engine — hiding that behind one boolean was a real Sigil defect that caused silent memory loss for hours:

```js
// src/cli-handlers/daemon.js — two dimensions, never one
const { data } = await client.call('ping', {});            // process alive?
const { data: st } = await client.call('status', {});      // DB alive?
dbLine = st?.db?.healthy ? '  database  healthy' : '  database  UNHEALTHY';
```

### 5.3 Standard names, standard flags

Follow the conventions users already know ([clig.dev](https://clig.dev/)): `--dry-run`, `--yes`/`-y`, `--force`, `--help`/`-h`, `--verbose`/`-v`. Make subcommands and flags order-independent. Reserve single-letter flags for the genuinely common ones. Don't invent a novel word when a standard one exists.

---

<a name="6-uninstall-and-reset"></a>
## 6. Uninstall and reset, done right (the cardinal discipline)

This section exists because of the field report: *"the uninstall and reset ran but the daemon kept running and kept calling `-p` sessions in a loop."* That bug is a teaching case for everything below.

### 6.1 The teardown is a *layered* operation

A core system app installs itself in **layers**, and teardown must peel them in the **reverse-dependency order**:

```
   Layer                      Installed by        Removed by
   ─────────────────────────────────────────────────────────────
6  Files (~/.sigil, shims)    install.sh          reset
5  Config (config.json)       init                reset
4  Data (database)            setup/provision     reset (--keep-db skips)
3  Supervisor unit            service install     service stop/uninstall
2  Daemon process            auto-spawn           daemon stop  ← the missing rung
1  Integrations (hooks/MCP)   init / connect      uninstall
```

The bug in the field report is that **rung 2 was never pulled by `uninstall`, and only weakly by `reset`.** `uninstall` removes rung 1 (integrations) and nothing else — by design. The user reasonably expected "uninstall" to stop the running process, but the running daemon is a *different layer*.

### 6.2 The ordering invariant: each step consumes the previous step's state

`reset` must run steps in an order where each step still has the state it needs:

```js
// src/cli.js — runReset, ordered for correctness
// 1. Drop the DB while config still points at it (FORCE handles live connections).
const r = await dropConfiguredDatabase();          // needs config.json → must run BEFORE wipe
// 2. Disconnect every coding agent (filesystem edits; doesn't need the daemon).
const removed = await disconnectAllClients();
// 3. Stop the daemon, THEN wipe ~/.sigil (which holds the pid/socket).
try { _execSync('pkill -f "dist/daemon.js"', { stdio: 'pipe' }); } catch {}
await fs.rm(sigilDir, { recursive: true, force: true });
await removeClaudeMdImport();
```

Why this order is forced:

- **Drop the DB before deleting the config that points to it.** A Docker-backed DB needs `config.json` to know the container name. Delete config first and you orphan the container forever.
- **Disconnect clients before killing the daemon** — fine here because client disconnect is pure filesystem work that doesn't need the daemon.
- **Kill the daemon before wiping `~/.sigil`**, which holds the PID/socket/lock files the daemon is actively using.

**Principle:** destructive teardown is a dependency graph, not a checklist. Topologically sort it: drop data before the config that addresses it; stop processes before deleting the files they hold open.

### 6.3 Where Sigil's own teardown is *still* weak (learn from this)

The field bug survived because the teardown has real gaps. State them plainly so your implementation doesn't repeat them:

1. **`uninstall` is silent about the running daemon.** A user who runs `uninstall` reasonably reads it as "stop the thing." Leaving a CPU-pinning daemon orphaned with no warning is a UX defect. **Fix:** after removing integrations, detect a running daemon and either offer to stop it or print a loud note with the exact command.

2. **`reset`'s daemon kill is a best-effort `pkill` with no verification.** It matches one cmdline pattern, has no SIGKILL escalation, doesn't confirm death, and **doesn't go through the supervisor-aware stop path** — so an installed launchd/systemd unit would resurrect the daemon mid-reset. **Fix:** reset should call the same disciplined stop as §3.4 (service-stop if supervised, else SIGTERM→wait→SIGKILL→verify), *before* deleting files.

3. **Auto-spawn is still armed during teardown.** If you kill the daemon but a hook is still wired into another tool (rung 1 not yet removed), the next event respawns it. **Fix:** remove integrations (rung 1) *before* killing the daemon (rung 2), so nothing is left to pull the trigger.

> **The rule that closes the bug:** *stop the resurrection mechanisms before you stop the process, and stop the process before you delete its files — then verify the process is actually dead.* Removal without stopping is the original sin; the orphan in the field report is its direct consequence.

### 6.4 Dry-run, confirmation, and best-effort fault tolerance

- **`--dry-run` everywhere it's cheap.** `uninstall --dry-run` computes the exact plan (which files, which keys) and prints it without writing. This is how a user audits blast radius before committing (`src/cli.js:502`, `543`).
- **Confirm destructive verbs; provide `--yes` for scripting.** `reset` prompts by default and accepts `--yes`/`--confirm`/`-y` (`src/cli.js:2071`). Interactive safety for humans, an escape hatch for automation.
- **Each teardown step is independently fault-tolerant.** A missing or broken client config must not abort the whole reset:

```js
// src/setup/reset.js — best-effort per client; one failure never aborts teardown
for (const c of clients) {
  try { const v = await c.verify(); if (v.installed) { await c.uninstall({ dryRun: false }); } }
  catch { /* best-effort per client */ }
}
```

### 6.5 In-app reset vs. CLI reset have different daemon assumptions

A subtlety worth internalizing: the **GUI reset runs *inside* the daemon** and must keep the daemon alive to serve the next screen, so it releases the DB handle in-process rather than killing anything. The **CLI reset runs *outside* the daemon** and can kill it externally. Same intent, opposite process assumptions:

```js
// src/setup/reset.js — in-app reset releases the handle, never pkills
await resetCortexPool();                    // close the WASM engine in THIS process
await rm(PGLITE_DB_PATH, { recursive: true, force: true });
resetConfig();                              // daemon stays alive to serve re-onboarding
```

**Principle:** "reset" means different things depending on *who is running it*. Be explicit about whether the daemon survives the operation.

---

<a name="7-configuration"></a>
## 7. Configuration management

### 7.1 One home directory, all paths centralized

Every persistent path is a named export from **one** module — never a hardcoded `~/.sigil` string scattered across the codebase. A rename becomes a one-line change, and tests can inject overrides:

```js
// src/lib/paths.js — the single source of truth for locations
export const SIGIL_HOME        = join(HOME, '.sigil');
export const SIGIL_CONFIG_PATH = join(SIGIL_HOME, 'config.json');
export const SIGIL_DB_PATH     = join(SIGIL_HOME, 'db');
export const SIGIL_DAEMON_SOCK = join(SIGIL_HOME, 'sock');
export const SIGIL_DAEMON_PID  = join(SIGIL_HOME, 'sigild.pid');
export const SIGIL_SPAWN_LOCK  = join(SIGIL_HOME, '.spawn.lock');
```

> **Platform note — XDG.** Sigil uses a single `~/.sigil/` dotdir. The modern Linux convention is the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/): config in `$XDG_CONFIG_HOME` (`~/.config/app`), data in `$XDG_DATA_HOME` (`~/.local/share/app`), state (logs, PID files) in `$XDG_STATE_HOME`, runtime sockets in `$XDG_RUNTIME_DIR`, cache in `$XDG_CACHE_HOME`. For a new cross-platform tool, prefer XDG on Linux (with the env-var overrides honored), `~/Library/Application Support` on macOS, `%APPDATA%`/`%LOCALAPPDATA%` on Windows. A single dotdir is simpler and fine for a focused tool, but it doesn't separate "back this up" (config/data) from "safe to delete" (cache/runtime) — which the XDG split gives you for free. Either way: centralize the decision in one module.

### 7.2 Sparse file + code defaults, merged at read time

The config file holds **only values the user explicitly set**. Defaults live in code and are merged in *on read*. This means a new release can change a default and every existing install picks it up — no migration of the file required. (Frozen defaults baked into a config file are exactly what made stale `.env` files break upgrades.)

```js
// src/setup/config-store.js — sparse overlay; defaults track the code
// "Write only values explicitly set. Defaults live in code and merge at READ time,
//  so defaults always track the code instead of freezing into the file."
```

### 7.3 Atomic writes — always tmp + rename

A config write that crashes mid-flight must never leave a corrupt file. Write to a temp file, `fsync`-equivalent, then atomically `rename`:

```js
// src/setup/config-store.js — never a torn config file
function atomicWrite(sparse) {
  const tmp = `${SIGIL_CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sparse, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, SIGIL_CONFIG_PATH);              // atomic on POSIX
}
```

Note the `0o600` mode — config can hold secrets (API keys, DB passwords), so it's owner-only from the moment it's created.

### 7.4 Precedence: config file is the single source of truth

In a long-lived daemon, config can change *while it runs* (the onboarding wizard writes a DB section while the daemon is already serving the GUI). So config fields are **lazy `get` accessors**, not values snapshotted at import — and they read the **store only**, never an env var:

```js
// src/config.js — store ?? hard default, read live. NO process.env.
get mode() { return store().database.mode ?? null; },
get host() { return store().database.host ?? 'localhost'; },
```

The hard-won lesson behind this: when config fields layered `process.env || store`, a stray global (a `LLM_PROVIDER=openai` left in a shell profile) silently overrode what the user selected during onboarding — and because the GUI showed the *stored* value, the override was invisible. "I picked claude-cli but it's calling OpenAI" with no way to see why. Letting any ambient env var outrank the file the user explicitly wrote is a trust bug.

So this tool makes **`config.json` the single source of truth for all configuration** — user-facing (db/llm/embedding) *and* infra (http port, timeouts, thresholds, managed-session). Defaults live in code and merge on read (§7.2), so "infra is prepopulated in the config" without freezing defaults into the file. The only values that stay in the environment are the ones that *physically cannot* live in the config file: **bootstrap/identity** — `HOME` (it locates the config file itself), per-process IPC tags (`SIGIL_DAEMON_PROCESS`, `SIGIL_AGENT`, `SIGIL_WORKER_ID`), launch/test path redirects (`SIGIL_PGLITE_PATH`), and OS/debug flags. Per-invocation **CLI flags** may still override transiently — explicit one-shot intent, not an ambient file.

> **Divergence from 12-Factor.** [12-Factor](https://12factor.net/config) argues for env-based config in *deployed* contexts (one immutable artifact, config injected per environment). A **local, user-installed** tool is the opposite case: there's one user, one machine, a GUI that writes config, and ambient shell env the user didn't intend as config. Here, env-as-config is a footgun, not a feature. Match the precedence model to who writes the config and how — for a local daemon, the file the onboarding wizard wrote wins.

### 7.5 Migrate legacy formats once, non-destructively

When you change config format, migrate exactly once and **rename the old file rather than deleting it** (recovery stays possible). Never clobber a section the new format already populated:

```js
// src/setup/config-store.js — one-shot, non-destructive .env migration
for (const [section, values] of Object.entries(patches)) {
  if (alreadySet[section]) continue;              // never clobber new wizard's values
  patchConfig(section, values);
}
renameSync(SIGIL_ENV_PATH, `${SIGIL_ENV_PATH}.migrated`);  // processed once; recoverable
```

### 7.6 Validate on write, stay tolerant on read

Catch bad config *when the user creates it* (a provider/model mismatch caused 161 silent failures in one week before this check existed). But never let a corrupt config crash the daemon on read — a daemon with broken config must stay alive to serve the setup UI that fixes it:

```js
// src/lib/config-validator.js — strict on write, tolerant on read
if (actualProvider && actualProvider !== provider) {
  issues.push({ level: 'fail', code: 'EMBEDDING_PROVIDER_MODEL_MISMATCH',
    message: `EMBEDDING_PROVIDER=${provider} but EMBEDDING_MODEL=${model} is a ${actualProvider} model.`,
    fix: suggestEmbeddingFix(provider, model, actualProvider) });
}
```

### 7.7 Reset stale in-progress flags at boot

Any "I'm working on it" flag written to durable config before the work finishes will be **frozen forever** if the process is killed mid-step. On every boot, demote leftover `active` flags back to `pending`:

```js
// src/setup/config-store.js — a crashed process can't un-set its own 'active'
// "On every load, demote any leftover 'active' back to 'pending' so the step is re-runnable."
```

---

<a name="8-state-ownership"></a>
## 8. State and data ownership

### 8.1 Single-process resources need a structural lock, not just etiquette

The deepest class of corruption bug in this software: **two processes opening a single-process resource.** Sigil's embedded PGlite (a WASM engine) aborts and *poisons its data directory* if two processes touch it. Code-level etiquette (§2.1) isn't enough, because two *daemons from different installs* both exempt themselves. The structural backstop is an `O_EXCL` owner lockfile:

```js
// src/db/pglite-adapter.js — the race-proof ownership lock
function acquireOwnerLock(dbPath) {
  const fd = openSync(lockPath, 'wx');             // atomic exclusive create — wins the race
  writeSync(fd, JSON.stringify({ pid: process.pid, root: PKG_ROOT, version }));
  // EEXIST → read holder → 'held' | 'reclaim' (dead pid) | 'refuse' (live foreign pid)
}
```

The lock records `pid`, install root, and engine version — enough for a human to diagnose a "refuse." It lives *outside* the data directory so backup/restore never captures it.

**Principle:** for any resource that physically tolerates only one owner, the guard must be (a) atomic to acquire, (b) able to reclaim a stale lock from a dead holder, and (c) informative enough to diagnose a live conflict.

### 8.2 Teardown order for live resources is strict

You cannot delete the files of a database that a process still holds open — the engine goes inconsistent and aborts the next query (the dreaded `Aborted()`). The release sequence is non-negotiable:

```
null the pool reference  →  destroy the pool  →  close the engine
  →  release the owner lock  →  ONLY THEN delete the data directory
```

```js
// src/db/cortex.js + pglite-adapter.js — release before delete
pool = null;                  // in-flight callers rebuild, don't retry a dead pool
await dead.destroy();         // knex pool → engine close
await inst.close();           // close the WASM instance
releaseOwnerLock();           // hand off ownership
// only now is rm(SIGIL_DB_PATH) safe
```

### 8.3 Wipe vs. drop: pick the primitive that matches intent

- **"Wipe data, keep schema"** (for a re-onboard that won't re-run migrations): `TRUNCATE … RESTART IDENTITY CASCADE` over every table except migration bookkeeping.
- **"Destroy the database"** (full teardown): drop the container+volume (Docker) or `DROP DATABASE … WITH (FORCE)` (local). **Never drop a managed/external DB the user owns** — report it as skipped instead (`src/setup/reset.js`).

```js
// src/setup/reset.js — external DBs are not yours to drop
return { kind: mode, dropped: false, detail: 'external/managed database left intact' };
```

### 8.4 Sole-ownership must be enforced at install/update, not just runtime

Runtime guards catch the conflict *after* a competitor exists. Better to prevent the competitor: at install and update time, evict any rival install of the same tool — carefully guarding against evicting *yourself*:

```js
// src/lib/git-update.js — the git install must be the SOLE owner of the embedded DB
export async function evictLegacyNpmInstall() {
  if (!existsSync(globalPkg)) return { evicted: false, reason: 'not-installed' };
  if (globalPkg === PKG_ROOT || PKG_ROOT.startsWith(globalPkg + sep))
    return { evicted: false, reason: 'self' };    // never evict the package we run from
  await runNpm(['rm', '-g', LEGACY_NPM_PKG]);
}
```

---

<a name="9-install-update"></a>
## 9. Installation, updates, and integrity

### 9.1 Idempotent installer

A re-run of the installer must be a no-op-or-update, never a duplicate. Sigil
distributes via git and makes "install" and "update" the same primitive —
`fetch + reset --hard` to a force-pushed release branch. Because the checkout
is still a local directory, preserve any tracked or untracked edits in a named,
recoverable stash immediately before the reset:

```sh
# install.sh — idempotent; re-run == update
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 --quiet origin "$BRANCH"
  if [ -n "$(git -C "$APP_DIR" status --porcelain)" ]; then
    git -C "$APP_DIR" stash push --include-untracked -m "sigil installer update"
  fi
  git -C "$APP_DIR" reset --hard --quiet FETCH_HEAD          # exact match; no 3-way conflict
else
  git clone --depth 1 --branch "$BRANCH" --quiet "$REPO" "$APP_DIR"
fi
```

`reset --hard` is correct *here* because the release branch is a derived CI
artifact — but its installer and `update` command both protect recoverable
local edits first. Match the update primitive to the artifact: `reset --hard`
for derived branches, `merge`/`pull` for source you expect users to modify.

### 9.2 The shim pattern: stable indirection that survives runtime churn

The single most important install decision: **never bake an absolute path to your binary into another tool's config.** Node version switches, reinstalls, and repo moves all invalidate baked paths. Instead, write a tiny stable **shim** at a fixed location and reference *that* everywhere; the shim re-resolves the real binary at call time and self-heals:

```sh
# src/lib/clients/shim.js — ~/.sigil/bin/sigil; self-heals if the recorded path moves
SIGIL_DIST='<recorded-at-init-time>'
CLI="$SIGIL_DIST/cli.js"
if [ ! -f "$CLI" ]; then
  ALT=$(command -v sigil 2>/dev/null)             # fall back to PATH
  case "$ALT" in ""|*/.sigil/bin/*) ;; *) CLI="$ALT" ;; esac
fi
exec "$NODE" "$CLI" "$@"
```

Every connector config (CLAUDE.md, `settings.json`, `mcp.json`) points at `~/.sigil/bin/sigil`, never at the package path. A node upgrade self-heals at the next `init` with no user action.

### 9.3 Refuse to persist from ephemeral runners

If your tool can be launched via `npx`/`pnpm dlx`, detect that the package lives in a soon-to-be-reaped cache and **refuse to write shims/hooks**, pointing at the real install method — otherwise every hook cold-boots from a cache that may vanish:

```js
// src/lib/paths.js — detect dlx/_npx; src/lib/clients/shim.js throws at the write choke-point
if (root.includes(`${sep}dlx${sep}`))  return { ephemeral: true, kind: 'pnpm-dlx', installHint: INSTALL_SH };
if (root.includes(`${sep}_npx${sep}`)) return { ephemeral: true, kind: 'npx',      installHint: INSTALL_SH };
```

### 9.4 Update = code and schema in lockstep, with auto-revert

A migration that runs new code against an old schema (or vice versa) is a broken system. `update` must keep them in lockstep and **roll back *both* on failure**:

```
1. snapshot the DB (restore point)
2. migrate.latest → on success: 'migrated'
3. on failure: rollback the partial batch
4. if schema reverted: also `git reset --hard` the CODE to the pre-update commit
5. restart the daemon on the now-consistent pair
```

```js
// src/cli-handlers/update.js — if the schema rolled back, revert the code to match
const landed = await revertInstall(from);     // code follows schema
await restartDaemon();
```

**Principle:** the unit of an update is the *(code, schema)* pair. Never leave them mismatched; if you can't move both forward, move both back.

### 9.5 Integrity guard anchored on the canonical install

Health/integrity checks must be anchored to the *blessed* install location (read by absolute path), not to `process.cwd()` or `import.meta.url` — so a stray foreign copy running `doctor` reports the truth about the canonical install, not a false-green about itself:

```js
// src/lib/install-state.js — anchored on ~/.sigil/app, not on the running copy
if (shimDist && !samePath(shimDist, canonical.dist))   issues.push({ code: 'shim-mismatch',      fix: 'sigil update --force' });
if (heartbeat?.version !== canonical.version)          issues.push({ code: 'daemon-stale',       fix: 'sigil daemon restart' });
if (heartbeat?.root && !samePath(heartbeat.root, canonical.dir)) issues.push({ code: 'daemon-foreign-root', fix: 'sigil daemon restart' });
```

---

<a name="10-integrations"></a>
## 10. Integrations: connectors, hooks, and plugins

A core system app rarely lives alone — it injects itself into *other* tools. Sigil connects to five AI agents (Claude Code, Cursor, Codex CLI, Kiro, and **Hermes**, an external server-side conversational-agent framework with its own Python memory-plugin API). The integration surface is where you most often corrupt *someone else's* config, so the discipline here is strict.

> **On "Hermes agent infra":** in this codebase, Hermes is an *external* product Sigil integrates with as one connector among five — not internal agent infrastructure. Notably, its integration uses neither MCP nor hooks; Sigil ships a Python memory-provider plugin into Hermes' own plugin system. The takeaway for *your* manual: a connector abstraction should be general enough that one connector can wire via hooks, another via an MCP entry, and a third via a foreign plugin runtime — all behind the same `detect/install/uninstall/verify` contract.

### 10.1 The connector contract

Define one interface, validate it at discovery, and make adding a connector a drop-in-one-file operation:

```js
// src/lib/clients/index.js — the contract every connector implements
//   detect():    is this client installed on the machine?
//   install():   ({dryRun}) => { actions }
//   uninstall(): ({dryRun}) => { actions }
//   verify():    is OUR tool installed *into* that client? (used by doctor)
```

### 10.2 Surgical merges: never clobber the host's config

When you edit a config file you don't own (Claude Code's `settings.json`, Cursor's `mcp.json`, Hermes' 14KB `config.yaml`), three rules:

1. **Add under a named key** so install/uninstall is a clean add/delete, not array surgery: `config.mcpServers.sigil = {…}` → uninstall is `delete config.mcpServers.sigil` (`src/lib/clients/cursor.js`).
2. **Filter-then-append by *your own* fingerprint** so re-running `init` replaces your prior entry instead of duplicating it:

```js
// src/lib/clients/claude-code.js — replace our hooks, never duplicate, never touch theirs
const filtered = existing.filter((h) => !h.hooks?.some((i) => isSigilHook(i.command)));
settings.hooks[event] = [...filtered, entry];
```

3. **Refuse to touch malformed JSON.** If the host file exists but won't parse, *do not* rewrite it — you'd silently wipe all the user's other settings. Surface it as a skip:

```js
// src/lib/clients/claude-code.js — corrupt host file → skip, never overwrite
if (err.code !== 'ENOENT') return { action: 'skip', path, detail: 'invalid JSON — not touched' };
```

4. **Back up before overwriting anything large/irreplaceable.** Hermes' connector drops a `.sigil.bak` before editing the user's 14KB config — "a backup is non-negotiable" (`src/lib/clients/hermes.js`).

### 10.3 Verify means "wired AND reachable"

`verify()` must check both that your entry exists in the host config *and* that the binary it points to exists on disk. Config-present + file-missing is a silent failure that a naive `doctor` reports as green:

```js
// src/lib/clients/claude-code.js — registered ≠ reachable
if (cmd.includes('sigil-hook') && !existsSync(HOOK_SHIM_PATH))
  return { installed: false, reason: `hook launcher missing: ${HOOK_SHIM_PATH}` };
```

### 10.4 Uninstall only removes what you set, and only if it's still yours

When clearing a setting you wrote, verify the *current value is still yours* before clearing — never stomp a value the user has since pointed elsewhere:

```js
// src/lib/clients/hermes.js — only clear memory.provider if it's still 'sigil'
// (never overwrite a user-set value pointing at another provider)
```

---

<a name="11-observability"></a>
## 11. Observability and self-healing

### 11.1 Logs, heartbeat, doctor

- **Append-only log**, opened with `flags: 'a'`, so the CLI can `--follow` by polling `stat().size` and reading new bytes — no `tail` subprocess, never truncated (`src/cli-handlers/daemon.js`).
- **Heartbeat file** (`{pid, ts, version}`, every 15s) doubles as liveness corroboration (§3.1) and stale-detection input.
- **`doctor`** diagnoses without fixing: config present, DB reachable, providers valid, hooks both registered *and* reachable, supervisor state, install integrity. It reports `ok`/`warn`/`fail` with a concrete `fix:` per issue.

### 11.2 Self-healing — and the precise danger of self-heal loops

This is where the field report's *"calling `-p` sessions in a loop"* comes from, so it deserves precision. Sigil's daemon can keep a warm pool of `claude` subprocess workers (the "managed-session engine") to avoid cold-starting an LLM process per call. A wedged or mis-supervised daemon driving that pool is exactly what pins a CPU and shells out repeatedly.

The lessons baked into the engine are a checklist for *any* self-healing loop:

```js
// src/lib/llm/session/manager.js — degrade, don't spin
// boot circuit breaker: after N consecutive boot failures, STOP respawning and fall back
if (fails >= this.maxBootFailures) {
  this.log(`worker failed to boot ${fails}× — staying on one-shot`);  // no respawn
}
```

```js
// src/daemon/db-monitor.js — recovery has a crash-loop guard
if (recoveryAttempts.length >= MAX_RECOVERIES) {            // 5 attempts / 5 min
  setDbHealth({ healthy: false, error: 'recovery crash-loop guard tripped' });
  return { recovered: false, skipped: 'crash-loop' };       // sit loud-unhealthy, wait for human
}
```

The five rules of a safe self-heal loop:

1. **Always have a fallback that's no worse than baseline.** A wedged warm worker falls back to the one-shot path; the engine is strictly additive, never a regression (`manager.js` dead-man timeout → `runFallbackRaw`).
2. **Circuit-break on repeated failure.** After N consecutive failures, *stop trying* and degrade — don't tight-loop.
3. **Rate-limit recovery.** Cap attempts per time window; after the cap, sit visibly unhealthy and wait for manual intervention.
4. **Probe actively for *blockage*, not just death.** A worker stuck on an interactive prompt ("trust this folder?", "usage limit reached") will never self-report — scan its output and recycle early (`manager.js:probeHealth`).
5. **Reconcile orphans on restart.** A crashed manager leaves worker subprocesses running forever; on restart, find and kill the ones you no longer own:

```js
// src/lib/llm/session/manager.js — kill orphaned workers we don't own
if (name.startsWith('sigil-') && !live.has(name)) await this.tmux.killSession(name);
```

> **The connection to the field bug:** the runaway `-p` loop is what happens when an *orphaned* daemon (one the supervisor or uninstall failed to stop) keeps driving its worker loop with no one watching. Rules 2 + 3 (circuit-break, rate-limit) bound the damage; §6 (correct teardown) prevents the orphan in the first place. Both layers matter — defense in depth.

### 11.3 Telemetry attribution

If the daemon does work on behalf of many callers, attribute it: record *who* triggered each action and *where* it ran (Sigil added caller attribution + an Engine view in commit `c5c3053`). Without attribution, a runaway loop is invisible — you see CPU, not cause.

---

<a name="12-security"></a>
## 12. Security

- **Owner-only file modes.** Config (secrets), the socket, and lockfiles are created `0o600`/`0o700` from the first byte (`config-store.js` `atomicWrite`).
- **Local HTTP needs auth too.** A daemon serving a GUI on `localhost` is reachable by every process on the machine. Sigil gates it with a token (`src/daemon/gui-token.js`) embedded in the URL — `localhost` is not a trust boundary on a multi-user or malware-present machine.
- **Never drop/modify resources you don't own.** External databases are reported and left intact (§8.3); user-set connector values are preserved (§10.4).
- **Validate before persisting.** Config validation (§7.6) is also a security control — it stops a malformed value from becoming a silently-failing or injectable setting.
- **Backups before destructive edits** to foreign config (§10.2) so a bug in your connector is recoverable.

---

<a name="13-cli-ux"></a>
## 13. CLI UX principles

Grounded in the [Command Line Interface Guidelines](https://clig.dev/) and the patterns above:

1. **Help text must tell the truth about blast radius.** `uninstall`'s help stating "your data is NOT touched — use reset for that" (`src/cli.js:494`) is the model. If a command is destructive, the `--help` should say exactly what it destroys.
2. **Human-first, but scriptable.** Confirm destructive actions interactively; provide `--yes` to bypass. Provide `--dry-run` to preview. Consider `--json` for machine-readable output.
3. **Errors should teach the next action.** "did not become ready within 5000ms" + the tail of the log (§3.3); "managed by the always-up service — run `sigil service stop`" (§3.4). Every error names the lever that fixes it.
4. **Exit codes are an API.** `0` success, non-zero failure, distinct codes for distinct failures so scripts can branch. `status` exits non-zero when the daemon is up but unresponsive (`src/cli-handlers/daemon.js`).
5. **Consistency across the verb family.** Same flag names, same confirmation semantics, same output shape. A user who learns `daemon stop` should be able to guess `service stop`.
6. **Discoverability.** A bare invocation lists verbs; `<verb> --help` documents each. Standard flags (`-h`, `-v`, `--version`) behave as expected.

---

<a name="14-testing"></a>
## 14. Testing lifecycle code

Lifecycle code is the hardest to test because it's about *processes, time, and crashes*. Targeted strategies:

- **Test detection logic against synthetic state.** Sigil has `lifecycle.detect.test.js` — feed it stale PID files, recycled PIDs, fresh/old heartbeats, and assert the cleanup decisions. No real process needed.
- **Make time and paths injectable.** Centralized paths (§7.1) let tests point `SIGIL_HOME` at a temp dir. Pass clocks/timeouts as parameters so you can simulate "did not exit in 10s."
- **Test the teardown *order*, not just the outcome.** Assert that `dropConfiguredDatabase` is called before the config is wiped, that clients are disconnected before the daemon is killed. Order bugs (§6.2) don't surface in outcome-only tests.
- **Simulate the crash, not just the clean exit.** The valuable cases are: killed mid-write (atomic-write recovery), killed mid-step (stale `active` flag reset), killed holding the DB handle (owner-lock reclaim).
- **Test idempotency explicitly.** Run `install` twice → no duplicate hooks. Run `uninstall` on a non-installed client → clean no-op. Run `stop` when not running → "not running," exit 0.
- **Round-trip the integration in `doctor --deep`.** Don't just check files exist — actually spawn the MCP server / run the hook and confirm it answers (`src/cli.js` doctor `--deep`).

---

<a name="15-anti-patterns"></a>
## 15. Anti-patterns: a field guide

Each of these is a real failure mode this manual's reference system hit and fixed.

| Anti-pattern | Symptom | The fix (section) |
|---|---|---|
| **Uninstall ≠ stop** | uninstalled the app; daemon kept running, pinned a CPU for 20+ hours | Peel layers in dependency order; stop the process and disarm respawn before removing files (§6) |
| **`pkill` as "stop"** | best-effort kill, no verify, supervisor resurrects it | Supervisor-aware SIGTERM→grace→SIGKILL→verify (§3.4) |
| **PID == liveness** | recycled PID after reboot read as "running"; or two daemons split-brain | Heartbeat + exclusive-port corroboration (§3.1–3.2) |
| **Respawn storm** | every concurrent hook forks its own daemon | Spawn lock + "busy" error instead of competitor (§3.3) |
| **Dueling installs** | two processes open the single-owner DB → `Aborted()` corruption | Sole-owner eviction at install + `O_EXCL` owner lock (§8.1, §8.4) |
| **Delete-before-release** | `rm` the DB dir while the engine holds it open → next query aborts | Strict release order: pool→engine→lock→then delete (§8.2) |
| **Baked absolute paths** | node upgrade / reinstall breaks every hook | Stable self-healing shim (§9.2) |
| **Code/schema skew** | failed migration leaves new code on old schema | Lockstep update with code+schema auto-revert (§9.4) |
| **Clobbering host config** | rewriting a host's `settings.json` wipes their other tools | Surgical named-key merge; skip malformed JSON; back up (§10.2) |
| **Liveness hides health** | daemon "running" with a dead DB → silent data loss for hours | Two-dimension `status` (§5.2) |
| **Self-heal tight loop** | recovery spins forever, pins CPU | Circuit breaker + rate-limited recovery + visible-unhealthy (§11.2) |
| **Frozen in-progress flag** | crashed mid-step → UI shows a step spinning forever | Demote `active`→`pending` at boot (§7.7) |
| **Side-effecting imports** | importing a module opens a connection → can't boot unconfigured | Lazy Proxy / accessors; safe import always (§2.4, §7.4) |

---

<a name="16-checklists"></a>
## 16. Checklists

### 16.1 Designing a `stop` command
- [ ] Read PID; if absent/dead → "not running", exit 0
- [ ] Check supervisor; if installed → refuse, point at `service stop`
- [ ] SIGTERM → poll for exit with a grace window sized to the flush cost
- [ ] On timeout → SIGKILL
- [ ] Re-verify death before returning success

### 16.2 Designing an `uninstall` command
- [ ] Removes *integrations only*; help text says data is untouched
- [ ] `--dry-run` prints the exact plan
- [ ] Surgical per-host removal (named-key delete / fingerprint filter)
- [ ] Each host fault-tolerant (one failure doesn't abort)
- [ ] **Detects a running daemon and tells the user how to stop it** (the field-report fix)

### 16.3 Designing a `reset` command
- [ ] Confirms by default; `--yes` to script; `--keep-db` escape hatch
- [ ] Order: drop DB (config still valid) → disconnect clients → **disarm respawn (remove hooks)** → **stop daemon (verified, supervisor-aware)** → delete home dir
- [ ] External/managed DBs reported, never dropped
- [ ] Idempotent and safe to re-run after a partial failure

### 16.4 Adding a daemon-owned resource
- [ ] Single source of truth for its path (§7.1)
- [ ] Acquisition guard: env-tag exemption + `O_EXCL` lock with stale reclaim
- [ ] Lazy construction; safe to import unconfigured
- [ ] Release sequence defined and tested before any delete path uses it
- [ ] `status` reports its health independently of process liveness

### 16.5 Adding a connector/integration
- [ ] Implements `detect / install / uninstall / verify`
- [ ] Merges surgically under a named key; never rewrites the whole host file
- [ ] Skips (doesn't overwrite) malformed host config; backs up large files
- [ ] References a stable shim, never a baked path
- [ ] `verify` checks wired **and** reachable
- [ ] `uninstall` clears only values still owned by you

---

<a name="17-references"></a>
## 17. References

**External standards & guides**
- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) — human-first CLI design, flags, subcommands, errors, config.
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) and the [Arch Wiki summary](https://wiki.archlinux.org/title/XDG_Base_Directory) — where config/data/state/cache/runtime belong.
- [The Twelve-Factor App — Config](https://12factor.net/config) — config precedence and env-based configuration.
- [systemd service restart & graceful shutdown](https://ihaveabackup.net/2022/01/30/systemd-killmodes-multithreading-and-graceful-shutdown/) — `Restart=`, `KillMode`, SIGTERM→SIGKILL semantics.

**Reference implementation (this repo) — key files**
- Daemon lifecycle: `src/daemon/lifecycle.js`, `src/daemon/index.js`
- Daemon control CLI: `src/cli-handlers/daemon.js`
- Auto-spawn: `src/clients/auto-spawn.js`
- Supervisor: `src/supervisor/{index,launchd,systemd,windows}.js`
- Config: `src/setup/config-store.js`, `src/config.js`, `src/lib/config-validator.js`, `src/lib/paths.js`
- Teardown: `src/cli.js` (`runUninstall` ~481, `runReset` ~2051), `src/setup/reset.js`
- Connectors: `src/lib/clients/{index,claude-code,cursor,hermes}.js`
- Install/update/integrity: `install.sh`, `src/cli-handlers/update.js`, `src/lib/clients/shim.js`, `src/lib/git-update.js`, `src/lib/install-state.js`, `src/db/migrate.js`
- DB ownership: `src/db/pglite-adapter.js`, `src/db/cortex.js`
- Self-healing: `src/daemon/db-monitor.js`, `src/lib/llm/session/manager.js`

---

*This manual is grounded in the Sigil codebase as of this writing. The `file:line` citations are illustrative anchors — verify against the current source before relying on a specific line. The principles outlast the line numbers.*
