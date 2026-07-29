/**
 * Docker-based local Postgres provisioning for "foolproof" onboarding.
 *
 * When Docker is available we can stand up a pgvector-enabled Postgres with
 * zero user effort: a named container (`sigil-postgres`) on a persistent
 * volume (`sigil-pgdata`, survives reboots), the `pgvector/pgvector` image
 * (ships the extension — sidesteps the "extension not available" trap), and a
 * least-privilege `sigil_app` role.
 *
 * Role/DB/extension setup runs via `docker exec … psql -U postgres` (local
 * peer auth) rather than a TCP admin connection — that removes any need to
 * persist the superuser password and makes container REUSE safe: we can always
 * reset the app password without knowing the original superuser secret.
 *
 * Everything here is best-effort and throws plain Errors with context; the
 * setup docker service (setup/db/docker.js) maps failures to clean StepErrors.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { probeUrlConnection, buildSigilSignature } from '../setup.js';
import { ensureInstallId } from '../../setup/config-store.js';

/**
 * Resolve the `docker` binary to an absolute path. The daemon runs under
 * launchd/systemd with a stripped PATH (/usr/bin:/bin:…) and can't see Docker
 * Desktop's bin dir, so a bare `spawn('docker')` fails with ENOENT even when
 * Docker is installed and running. Probe the usual install locations and fall
 * back to the bare name so a PATH that DOES contain it still works.
 */
let dockerBin = null;
function resolveDockerBin() {
  if (dockerBin) return dockerBin;
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    `${process.env.HOME || ''}/.docker/bin/docker`,
    '/usr/bin/docker',
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return (dockerBin = p);
  }
  return (dockerBin = 'docker');
}

export const CONTAINER = 'sigil-postgres';
export const VOLUME = 'sigil-pgdata';
export const IMAGE = 'pgvector/pgvector:pg16';
const DB_NAME = 'sigil';
const APP_USER = 'sigil_app';

function run(cmd, args, { timeout = 15000, input } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message, spawnError: true });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, timeout);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message, spawnError: true }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
    if (input != null) { proc.stdin.write(input); proc.stdin.end(); }
  });
}

/**
 * Probe Docker. Distinguishes three states so the UI can react:
 *   - not installed          → { installed:false, running:false, available:false }
 *   - installed, daemon down  → { installed:true,  running:false, available:false }
 *   - ready                   → { installed:true,  running:true,  available:true }
 *
 * NOT cached: Docker Desktop is frequently started/stopped, and a stale cached
 * "available" left provisioning to fail later with a raw socket error. The
 * probes are fast (a down daemon fails immediately), so re-probing is cheap.
 */
export async function detectDocker() {
  const bin = resolveDockerBin();
  // Client present? `--version` is client-only — works even with the daemon down.
  const cli = await run(bin, ['--version'], { timeout: 5000 });
  if (cli.code !== 0 || cli.spawnError) {
    return { available: false, installed: false, running: false, version: null, reason: 'Docker is not installed.' };
  }
  // Daemon reachable?
  const srv = await run(bin, ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
  if (srv.code === 0 && srv.out) {
    return { available: true, installed: true, running: true, version: srv.out, reason: null };
  }
  return { available: false, installed: true, running: false, version: null, reason: 'Docker is installed but not running.' };
}

/**
 * Start the Docker engine and wait until it accepts connections. macOS:
 * `open -a Docker` (Docker Desktop); Linux: `systemctl start docker` (best
 * effort — may need privileges). Throws if it doesn't come up in time.
 */
export async function startDockerEngine({ timeoutMs = 90000 } = {}) {
  if (process.platform === 'darwin') {
    await run('open', ['-a', 'Docker'], { timeout: 10000 });
  } else if (process.platform === 'linux') {
    await run('systemctl', ['start', 'docker'], { timeout: 15000 });
  } else {
    throw new Error('Automatic Docker start is not supported on this platform.');
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await detectDocker()).running) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Docker did not become ready in time. Start Docker Desktop and retry.');
}

async function containerState() {
  const r = await run(resolveDockerBin(),['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeout: 8000 });
  if (r.code !== 0) return { exists: false, running: false };
  return { exists: true, running: r.out === 'true' };
}

async function containerPort() {
  const r = await run(resolveDockerBin(),['port', CONTAINER, '5432/tcp'], { timeout: 8000 });
  if (r.code !== 0) return null;
  const m = r.out.match(/:(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

function genPassword() {
  // base64url → only [A-Za-z0-9_-], safe in SQL single-quotes AND URLs.
  return randomBytes(18).toString('base64url');
}

/** Run SQL inside the container as the postgres superuser (peer auth). */
async function psql(db, sql) {
  const r = await run(
    resolveDockerBin(),
    ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db],
    { input: sql, timeout: 20000 },
  );
  if (r.code !== 0) throw new Error(`psql(${db}) failed: ${r.err || r.out || `exit ${r.code}`}`);
  return r.out;
}

async function waitForReady({ deadlineMs = 30000 } = {}) {
  const t0 = Date.now();
  let lastErr = 'timed out';
  while (Date.now() - t0 < deadlineMs) {
    const r = await run(resolveDockerBin(),['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { timeout: 5000 });
    if (r.code === 0) return;
    lastErr = r.err || r.out || lastErr;
    await new Promise((res) => setTimeout(res, 700));
  }
  throw new Error(`Postgres did not become ready in ${deadlineMs}ms: ${lastErr}`);
}

/**
 * Provision (or reuse) the local Postgres container and return a ready-to-use
 * least-privilege connection URL. Idempotent: re-running reuses the existing
 * container + volume and only resets the app password.
 *
 * @returns {Promise<{ url, port, container, image, reused, pgvector }>}
 */
export async function provisionLocalPostgres({ onProgress } = {}) {
  const docker = await detectDocker();
  if (!docker.available) {
    const e = new Error(docker.reason || 'Docker is not available');
    e.dockerUnavailable = true;
    throw e;
  }

  const state = await containerState();
  let port;
  const appPw = genPassword();

  if (state.exists) {
    if (!state.running) {
      const started = await run(resolveDockerBin(),['start', CONTAINER], { timeout: 15000 });
      if (started.code !== 0) throw new Error(`failed to start existing ${CONTAINER}: ${started.err}`);
    }
    port = (await containerPort()) || 5432;
  } else {
    // Pull the image FIRST, on its own generous timeout. `docker run` would
    // otherwise pull inline under the run timeout and fail on a first run /
    // slow network with "Unable to find image locally". Skip if already pulled.
    const haveImage = await run(resolveDockerBin(), ['image', 'inspect', IMAGE], { timeout: 10000 });
    if (haveImage.code !== 0) {
      onProgress?.(`Pulling Postgres image (${IMAGE}) — first run, this can take a minute…`);
      const pulled = await run(resolveDockerBin(), ['pull', IMAGE], { timeout: 600000 });
      if (pulled.code !== 0) {
        throw new Error(`failed to pull ${IMAGE}: ${(pulled.err || pulled.out || 'unknown').slice(0, 300)}`);
      }
    }
    onProgress?.('Starting the container…');
    const superPw = genPassword();
    // Let Docker pick a free host port on the loopback interface (`-p
    // 127.0.0.1::5432`) instead of guessing one. Guessing with a host-side
    // bind check misses ports already published by OTHER containers (e.g. a
    // sibling project on 5432), which made `docker run` fail with "port is
    // already allocated". We read the assigned port back via `docker port`.
    const created = await run(resolveDockerBin(),[
      'run', '-d',
      '--name', CONTAINER,
      '--restart', 'unless-stopped',
      '-e', `POSTGRES_PASSWORD=${superPw}`,
      '-e', `POSTGRES_DB=${DB_NAME}`,
      '-v', `${VOLUME}:/var/lib/postgresql/data`,
      '-p', '127.0.0.1::5432',
      IMAGE,
    ], { timeout: 60000 });
    if (created.code !== 0) {
      // Most common real-world failure: image needs pulling, or name clash.
      throw new Error(`docker run failed: ${created.err || created.out}`);
    }
    port = (await containerPort()) || 5432;
  }

  await waitForReady();

  // Ensure database, least-privilege role, grants, and pgvector — all via peer
  // auth inside the container (no superuser password needed).
  const dbExists = await psql('postgres', `SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'`);
  if (!dbExists.includes('1')) await psql('postgres', `CREATE DATABASE ${DB_NAME}`);

  await psql('postgres', `DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='${APP_USER}') THEN
      ALTER ROLE ${APP_USER} WITH LOGIN PASSWORD '${appPw}';
    ELSE
      CREATE ROLE ${APP_USER} WITH LOGIN PASSWORD '${appPw}';
    END IF;
  END $$;`);
  await psql('postgres', `GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${APP_USER}`);
  await psql(DB_NAME, `GRANT ALL ON SCHEMA public TO ${APP_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${APP_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${APP_USER};
    CREATE EXTENSION IF NOT EXISTS vector;`);

  // Stamp the database so detection can later prove it's Sigil's own. The
  // container's `postgres` superuser owns the db, so this always succeeds.
  await psql('postgres', `COMMENT ON DATABASE ${DB_NAME} IS '${buildSigilSignature(ensureInstallId())}'`);

  const url = `postgres://${APP_USER}:${encodeURIComponent(appPw)}@localhost:${port}/${DB_NAME}`;

  // Verify over TCP exactly as the external-URL path does.
  const probe = await probeUrlConnection(url);
  if (!probe.ok) {
    throw new Error(`provisioned container did not accept a TCP connection (${probe.stage}): ${probe.error}`);
  }

  return { url, port, container: CONTAINER, image: IMAGE, reused: state.exists, pgvector: probe.pgvector };
}

/**
 * Daemon-start convenience: if the configured DB is the local container and it
 * exists-but-stopped, start it. Best-effort, never throws.
 * @returns {Promise<{ started: boolean, reason?: string }>}
 */
export async function ensureLocalPostgresRunning() {
  try {
    const { default: config } = await import('../../config.js');
    const url = config.db.url || '';
    if (!/@localhost:|@127\.0\.0\.1:/.test(url)) return { started: false, reason: 'not a local url' };
    const docker = await detectDocker();
    if (!docker.available) return { started: false, reason: 'docker unavailable' };
    const state = await containerState();
    if (!state.exists) return { started: false, reason: 'no sigil-postgres container' };
    if (state.running) return { started: false, reason: 'already running' };
    const r = await run(resolveDockerBin(),['start', CONTAINER], { timeout: 15000 });
    return r.code === 0 ? { started: true } : { started: false, reason: r.err };
  } catch (e) {
    return { started: false, reason: e.message };
  }
}

export async function stopLocalPostgres() {
  return run(resolveDockerBin(),['stop', CONTAINER], { timeout: 20000 });
}

export async function removeLocalPostgres({ deleteVolume = false } = {}) {
  await run(resolveDockerBin(),['rm', '-f', CONTAINER], { timeout: 20000 });
  if (deleteVolume) await run(resolveDockerBin(),['volume', 'rm', VOLUME], { timeout: 15000 });
}
