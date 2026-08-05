/**
 * `sigil daemon` — control the long-running sigild process.
 *
 * Subcommands:
 *   start [--foreground]   Start the daemon (detached by default).
 *   stop                   SIGTERM the running daemon.
 *   status                 Show pid, uptime, version.
 *   logs [--follow]        Print (or tail) the daemon log.
 *   restart                stop + start.
 */
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SIGIL_DAEMON_LOG,
  SIGIL_DAEMON_PID,
  SIGIL_DAEMON_SOCK,
} from '../lib/paths.js';
import {
  detectRunningDaemon,
  isPidAlive,
  readPidFile,
} from '../daemon/lifecycle.js';
import { openSocketClient } from '../clients/socket-client.js';
import { connectOrStartDaemon } from '../clients/auto-spawn.js';
import { formatUptime } from '../lib/format.js';

const HELP = `sigil daemon — control the Sigil daemon

Usage:
  sigil daemon start [--foreground]
  sigil daemon stop
  sigil daemon status
  sigil daemon restart
  sigil daemon logs [--follow]
  sigil daemon open                 Open the GUI in your browser
  sigil daemon url                  Print the GUI URL (with auth token)

The daemon is the single owner of local storage shared by every CLI verb,
MCP client, and hook on this machine. The browser server starts only when
you run \`sigil\`, \`sigil daemon open\`, or \`sigil daemon url\`.

Files:
  ${SIGIL_DAEMON_SOCK}    Unix socket
  ${SIGIL_DAEMON_PID}     PID file
  ${SIGIL_DAEMON_LOG}     Append-only log`;

export async function runDaemon(args) {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case 'start':    return cmdStart(rest);
    case 'stop':     return cmdStop(rest);
    case 'status':   return cmdStatus(rest);
    case 'restart':  return cmdRestart(rest);
    case 'logs':     return cmdLogs(rest);
    case 'open':     return cmdOpen({ launch: true });
    case 'url':      return cmdOpen({ launch: false });
    default:
      console.error(`Unknown subcommand: daemon ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function cmdOpen({ launch }) {
  // Ensure daemon is running (auto-spawn).
  const c = await connectOrStartDaemon({ quiet: true });
  const response = await c.call('gui.start', {});
  await c.close();
  if (!response.ok || !response.data?.url) {
    throw new Error(response.error?.message || 'failed to start the local Sigil UI');
  }
  const url = response.data.url;
  console.log(url);

  if (!launch) return;
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'start' :
    'xdg-open';
  const { spawn } = await import('node:child_process');
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function cmdStart(args) {
  const foreground = args.includes('--foreground') || args.includes('-f');

  const existing = await detectRunningDaemon();
  if (existing) {
    console.log(`sigild already running (pid ${existing})`);
    return;
  }

  if (foreground) {
    // exec the daemon in this process so user sees logs interactively
    const { startDaemon } = await import('../daemon/index.js');
    await startDaemon({ foreground: true });
    // startDaemon doesn't block — keep the event loop alive.
    return;
  }

  // Detached spawn. Reuse the auto-spawn machinery so behaviour matches
  // implicit start on first CLI call.
  await connectOrStartDaemon({ quiet: true })
    .then(async (c) => {
      const { data } = await c.call('ping', {});
      await c.close();
      console.log(`sigild started (pid ${data.pid}, version ${data.version})`);
    });
}

/**
 * Restart semantics must respect the process owner. When automatic start is
 * enabled, launchd/systemd owns the daemon; sending SIGTERM from this CLI and
 * immediately calling `start` only observes the still-managed process and
 * leaves the old executable running. Refresh the existing service unit in
 * that case so it follows the current Sigil checkout before it restarts.
 */
export async function restartDaemonLifecycle({
  isServiceInstalled,
  refreshService,
  stop,
  start,
  sleep = delay,
} = {}) {
  if (await isServiceInstalled()) {
    const result = await refreshService();
    if (!result?.ok) {
      throw new Error(`could not restart the ${result?.manager || 'managed'} Sigil service`);
    }
    return { managed: true, manager: result.manager };
  }

  await stop();
  await sleep(200);
  await start();
  return { managed: false };
}

async function cmdRestart(args) {
  const supervisor = await import('../supervisor/index.js');
  const result = await restartDaemonLifecycle({
    isServiceInstalled: supervisor.isServiceInstalled,
    refreshService: supervisor.refreshService,
    stop: () => cmdStop(args),
    start: () => cmdStart(args),
  });
  if (result.managed) {
    console.log(`sigild restarted through ${result.manager} (automatic start remains enabled)`);
  }
}

async function cmdStop() {
  const pid = await readPidFile();
  if (!pid || !isPidAlive(pid)) {
    console.log('sigild is not running');
    return;
  }
  // If an always-up service is installed, a plain SIGTERM gets resurrected by
  // launchd KeepAlive / systemd Restart=always. Tell the user the real lever.
  try {
    const { isServiceInstalled } = await import('../supervisor/index.js');
    if (await isServiceInstalled()) {
      console.log('sigild is managed by the always-up service — it will auto-restart after a stop.');
      console.log('To keep it down, run:  sigil service stop   (re-enable with `sigil service start`)');
      return;
    }
  } catch { /* supervisor unavailable — fall through to a normal stop */ }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`failed to signal pid ${pid}: ${err.message}`);
    process.exit(1);
  }
  // Wait for clean exit. The embedded store runs CHECKPOINT + close on SIGTERM
  // (field-report Defect 1) — give it room so SIGKILL can't interrupt the flush and
  // tear the checkpoint. A genuinely hung daemon still gets force-killed after this.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(pid)) await delay(50);
  if (isPidAlive(pid)) {
    console.error(`sigild (pid ${pid}) did not exit within 10s — sending SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  console.log('sigild stopped');
}

async function cmdStatus() {
  const pid = await readPidFile();
  if (!pid || !isPidAlive(pid)) {
    console.log('sigild: not running');
    return;
  }
  try {
    const client = await openSocketClient({ timeoutMs: 2_000 });
    const { data } = await client.call('ping', {});
    // DB health is distinct from daemon liveness (field-report Defect 3): the
    // process can be up and the socket reachable while the embedded engine is
    // dead. Probe it via status so a wedged DB is visible here, not hidden.
    let dbLine = '  database  unknown';
    try {
      const { data: st } = await client.call('status', {});
      dbLine = st?.db?.healthy
        ? '  database  healthy'
        : `  database  UNHEALTHY${st?.db?.error ? ` — ${String(st.db.error).split('\n')[0]}` : ''}`;
    } catch (e) { dbLine = `  database  unknown — ${e.message.split('\n')[0]}`; }
    await client.close();
    console.log(`sigild: running`);
    console.log(`  pid       ${data.pid}`);
    console.log(`  version   ${data.version}`);
    console.log(`  node      ${data.node}`);
    console.log(`  uptime    ${formatUptime(data.uptimeMs)}`);
    console.log(`  socket    ${SIGIL_DAEMON_SOCK}`);
    console.log(dbLine);
  } catch (err) {
    console.log(`sigild: pid ${pid} alive but socket unresponsive (${err.message})`);
    process.exit(1);
  }
}

async function cmdLogs(args) {
  const follow = args.includes('--follow') || args.includes('-f');
  if (!existsSync(SIGIL_DAEMON_LOG)) {
    console.log(`(no log file yet at ${SIGIL_DAEMON_LOG})`);
    return;
  }

  // Print whole file, then optionally tail.
  await new Promise((resolve, reject) => {
    const stream = createReadStream(SIGIL_DAEMON_LOG, { encoding: 'utf8' });
    stream.on('data', (chunk) => process.stdout.write(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (!follow) return;

  // Naive polling tail — small log file, this is fine. Refine if needed.
  let lastSize = (await stat(SIGIL_DAEMON_LOG)).size;
  // Keep the process alive until Ctrl-C.
   
  while (true) {
    await delay(250);
    const s = await stat(SIGIL_DAEMON_LOG).catch(() => null);
    if (!s || s.size === lastSize) continue;
    const stream = createReadStream(SIGIL_DAEMON_LOG, {
      encoding: 'utf8',
      start: lastSize,
      end: s.size - 1,
    });
    stream.on('data', (chunk) => process.stdout.write(chunk));
    await new Promise((res, rej) => { stream.on('end', res); stream.on('error', rej); });
    lastSize = s.size;
  }
}

// formatUptime moved to src/lib/format.js (PR review #26).
