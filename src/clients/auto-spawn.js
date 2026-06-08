import { spawn } from 'node:child_process';
import {
  existsSync, openSync, closeSync, mkdirSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SIGIL_DAEMON_LOG,
  SIGIL_DAEMON_SOCK,
  SIGIL_HOME,
  SIGIL_SPAWN_LOCK,
} from '../lib/paths.js';
import { detectRunningDaemon, isPidAlive } from '../daemon/lifecycle.js';
import { resolveDaemonScript } from '../supervisor/entry-path.js';
import { openSocketClient } from './socket-client.js';

const READY_TIMEOUT_MS = 5_000;
// PR review #15: exponential backoff. Typical cold start is well under
// 1 second; the first few polls catch it fast, then we space out so we
// don't burn CPU on slow boots.
const POLL_INTERVAL_MIN_MS = 25;
const POLL_INTERVAL_MAX_MS = 400;

// F5: when the first ping fails but a daemon process is provably alive
// (heartbeat / healthz), give the incumbent this long to answer before giving
// up. Short — a warm daemon answers instantly; this only absorbs a daemon that
// was momentarily busy between RPCs. We deliberately do NOT spawn a competitor.
const BUSY_GRACE_MS = 1_200;
// A spawn lock older than this is treated as abandoned (the spawner crashed) and
// stolen, so a dead lock can never wedge every future start.
export const SPAWN_LOCK_TTL_MS = 15_000;

/**
 * The daemon process is alive (heartbeat/healthz prove it) but didn't answer
 * our ping within the grace window — it's busy or wedged, not absent. Callers
 * should degrade (skip injection, spool the save) rather than spawn a second
 * daemon: the embedded DB is single-process, so a competitor can never take the
 * lock and just churns the CPU. This is the F5 respawn-storm guard, surfaced as
 * a typed error so hooks can trip their circuit breaker on it specifically.
 */
export class SigilDaemonBusyError extends Error {
  constructor(pid) {
    super(`sigil daemon (pid ${pid}) is alive but not responding — run \`sigil daemon restart\` if this persists`);
    this.name = 'SigilDaemonBusyError';
    this.code = 'daemon_busy';
    this.pid = pid;
  }
}

/**
 * Return an open socket client to the daemon, starting the daemon first
 * if it isn't running.
 *
 * Behavior:
 *   1. If the daemon answers a ping, just connect.
 *   2. If the first ping fails but a daemon is provably ALIVE (heartbeat /
 *      healthz survive a pegged event loop), give it a short grace window —
 *      then throw SigilDaemonBusyError instead of forking a doomed competitor.
 *      Spawning into a live daemon was the F5 CPU storm: every caller forked a
 *      node that printed "already running" and exited.
 *   3. Only when NO daemon is alive do we spawn — and we serialize that spawn
 *      with a lockfile so a burst of concurrent callers starts exactly one.
 *   4. Cap the total wait at READY_TIMEOUT_MS.
 */
export async function connectOrStartDaemon({ quiet = false, timeoutMs } = {}) {
  const opts = timeoutMs ? { timeoutMs } : undefined;
  if (await canConnect()) {
    return openSocketClient(opts);
  }

  // First ping failed. Is a daemon nonetheless alive? detectRunningDaemon uses
  // the heartbeat + /healthz, which stay accurate even when the event loop is
  // briefly pegged, so it distinguishes "busy/wedged" from "genuinely absent".
  const existing = await detectRunningDaemon();
  if (existing) {
    if (await waitForResponsive(BUSY_GRACE_MS)) return openSocketClient(opts);
    // Alive but unresponsive — do NOT spawn. Let the caller degrade.
    throw new SigilDaemonBusyError(existing);
  }

  // No daemon is alive — start one, serialized so concurrent callers don't each
  // fork their own (the spawn lock is the F5 concurrency cap).
  await spawnDaemonSerialized({ quiet });
  await waitForReady();
  return openSocketClient(opts);
}

async function canConnect() {
  if (!existsSync(SIGIL_DAEMON_SOCK)) return false;
  try {
    const c = await openSocketClient({ timeoutMs: 1_000 });
    await c.call('ping', {});
    await c.close();
    return true;
  } catch {
    return false;
  }
}

/** Poll canConnect() up to `ms`, returning true as soon as the daemon answers. */
async function waitForResponsive(ms) {
  const deadline = Date.now() + ms;
  let interval = POLL_INTERVAL_MIN_MS;
  while (Date.now() < deadline) {
    if (await canConnect()) return true;
    await delay(interval);
    interval = Math.min(interval * 2, POLL_INTERVAL_MAX_MS);
  }
  return false;
}

/**
 * Acquire the spawn lock (O_EXCL create), spawn the daemon, and release. If
 * another process already holds a fresh lock, don't spawn — its waitForReady()
 * will pick up the winner. A stale lock (older than SPAWN_LOCK_TTL_MS or owned
 * by a dead pid) is stolen so a crashed spawner can't block every future start.
 */
async function spawnDaemonSerialized({ quiet }) {
  mkdirSync(SIGIL_HOME, { recursive: true });
  if (!acquireSpawnLock()) {
    // Someone else is spawning right now — let them win; we just wait.
    return;
  }
  try {
    // Re-check under the lock: another process may have finished spawning in the
    // window between our detectRunningDaemon() above and acquiring the lock.
    if (await canConnect()) return;
    if (!quiet) process.stderr.write('[sigil] daemon not running, starting it...\n');
    await spawnDaemon();
  } finally {
    releaseSpawnLock();
  }
}

/**
 * Try to take the spawn lock; returns true on success. Steals a stale lock (one
 * older than SPAWN_LOCK_TTL_MS or owned by a dead pid) so a crashed spawner can
 * never deadlock every future start. Exported (with an injectable path) for
 * tests. (F5 concurrency cap.)
 */
export function acquireSpawnLock(path = SIGIL_SPAWN_LOCK) {
  try {
    const fd = openSync(path, 'wx'); // fails if it already exists
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // Lock exists — steal it only if the holder is gone or it's older than the TTL.
  let holder = null;
  try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* corrupt */ }
  const stale =
    !holder ||
    !Number.isFinite(holder.ts) ||
    Date.now() - holder.ts > SPAWN_LOCK_TTL_MS ||
    (Number.isFinite(holder.pid) && !isPidAlive(holder.pid));
  if (!stale) return false;
  try { unlinkSync(path); } catch { /* raced */ }
  try {
    const fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    return true;
  } catch {
    return false; // another process stole it first — let them spawn
  }
}

export function releaseSpawnLock(path = SIGIL_SPAWN_LOCK) {
  try { unlinkSync(path); } catch { /* already gone */ }
}

async function spawnDaemon() {
  // Fresh-install safety: ensure SIGIL_HOME exists BEFORE we try to
  // open the log file as the parent's stdio target. The child would
  // also create it, but the openSync() calls below run in the parent
  // and would ENOENT on a brand-new install. (PR review #3.)
  mkdirSync(SIGIL_HOME, { recursive: true });

  // Defensive cleanup: detectRunningDaemon clears stale pid/socket files
  // if no live daemon exists. Without this, a previous crash can leave
  // ~/.sigil/sock behind and the new daemon will refuse to bind.
  await detectRunningDaemon();

  const daemonScript = resolveDaemonScript();

  // Detach completely so the daemon outlives this CLI process. stdio is
  // sent to the log file (append) instead of /dev/null so a crash on
  // startup leaves a trail.
  const out = openSync(SIGIL_DAEMON_LOG, 'a');
  const err = openSync(SIGIL_DAEMON_LOG, 'a');

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      SIGIL_DAEMON_AUTOSPAWN: '1',
    },
  });
  child.unref();

  // Close our copies of the fds — the child has them now.
  try { closeSync(out); } catch { /* ignore */ }
  try { closeSync(err); } catch { /* ignore */ }
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let interval = POLL_INTERVAL_MIN_MS;
  while (Date.now() < deadline) {
    if (await canConnect()) return;
    await delay(interval);
    interval = Math.min(interval * 2, POLL_INTERVAL_MAX_MS);
  }
  // The daemon never bound its socket in time. The actionable part is *why* —
  // which the daemon wrote to its log right before exiting. Inline the tail so
  // the caller sees the real cause ("already running", a bind error, a stack)
  // instead of having to go open the file themselves.
  const tail = readLogTail(SIGIL_DAEMON_LOG, 12);
  const suffix = tail
    ? `\n\n--- ${SIGIL_DAEMON_LOG} (last lines) ---\n${tail}`
    : ` — check ${SIGIL_DAEMON_LOG}`;
  throw new Error(
    `daemon did not become ready within ${READY_TIMEOUT_MS}ms${suffix}`,
  );
}

/** Best-effort read of the last `n` non-empty lines of the daemon log. */
function readLogTail(path, n) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    return lines.slice(-n).join('\n');
  } catch {
    return ''; // log missing / unreadable — caller falls back to the path.
  }
}
