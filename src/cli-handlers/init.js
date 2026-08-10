/**
 * `sigil init` — interactive first-run wizard (terminal).
 *
 * Drives the SAME headless step engine as the GUI dashboard
 * (src/setup/service.js), writing ONLY to ~/.sigil/config.json. There is no
 * `.env` path anymore: every choice is persisted through patchConfig() by the
 * step modules, so the terminal wizard and the browser wizard can never diverge.
 *
 * The five steps mirror the dashboard one-for-one:
 *   1. Database     — Built-in (PGlite) · local Postgres · Docker · external URL
 *   2. LLM provider — Claude Code · OpenRouter · OpenAI · Anthropic · Ollama
 *   3. Embeddings   — OpenAI · Voyage · OpenRouter · Ollama (pinned to 1024-dim)
 *   4. Coding agents— connect Claude Code / Cursor / Codex / Kiro / Hermes
 *   5. Your name    — stored + written as the first memory (full-stack smoke test)
 *
 * Each step runs in-process and streams the service's live progress events
 * (bus 'setup' → clack spinner), exactly mirroring the GUI's progress bar.
 */
import { detectRunningDaemon } from '../daemon/lifecycle.js';

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'that server'; }
}

/** Render a step's error (+ optional hint) into a clack note. */
function stepErrorText(res) {
  const msg = res.error || (res.errors && Object.values(res.errors)[0]) || 'Setup failed.';
  return res.hint ? `${msg}\n\n→ ${res.hint}` : msg;
}

/**
 * Run one engine step with a live spinner fed by the bus 'setup' events (the
 * same stream the GUI renders as a progress bar). Returns the service result
 * ({ ok, result?|error?, hint?, errors? }).
 */
async function execStep(clack, runStep, id, input, { start, ok }) {
  const bus = (await import('../daemon/events.js')).default;
  const s = clack.spinner();
  s.start(start);
  // The bus broadcasts every event type to each subscriber; filter to this
  // step's 'setup' progress. subscribe() returns its own unsubscribe fn.
  const unsub = bus.subscribe((e) => { if (e.type === 'setup' && e.step === id && e.label) s.message(e.label); });
  let res;
  try {
    res = await runStep(id, input);
  } finally {
    unsub();
  }
  s.stop(res.ok ? (typeof ok === 'function' ? ok(res.result) : ok) : `${id} step failed`);
  return res;
}

/** Prompt for each field descriptor in order; returns the collected values. */
async function collectFields(clack, guard, fields) {
  const out = {};
  for (const f of fields) {
    // A field with a known set of valid values is a pick, not a typing exercise.
    // The LLM step uses this for model choice (claude-cli aliases, the locally
    // installed Ollama models, curated OpenAI/Anthropic ids) — before it, the
    // only way to set a model was to type an id from memory, and claude-cli had
    // no field at all so it silently used its default forever.
    if (f.type === 'select' && f.options?.length) {
      const v = guard(await clack.select({
        message: f.label,
        options: f.options.map((o) => ({ value: o.value, label: o.label || o.value, hint: o.hint })),
        initialValue: f.default || f.options[0].value,
      }));
      if (v) out[f.name] = v;
      continue;
    }
    const ask = f.type === 'password' ? clack.password : clack.text;
    const v = guard(await ask({
      message: f.label + (f.optional ? ' (optional)' : ''),
      placeholder: f.placeholder || '',
      validate: (val) => { if (!f.optional && !String(val || '').trim()) return 'Required'; },
    }));
    if (v) out[f.name] = v;
  }
  return out;
}

// ── 1. Database ───────────────────────────────────────────────────────────────
async function stepDatabase(ctx, { urlFlag }) {
  const { clack, guard, runStep, detectStep } = ctx;

  // Non-interactive shortcut: --url skips the picker (scripted dotfile installs).
  if (urlFlag) {
    const res = await execStep(clack, runStep, 'database', { mode: 'url', url: urlFlag },
      { start: 'Setting up the database…', ok: (r) => `Database ready (${r.provider || r.mode}).` });
    if (res.ok) return;
    clack.note(stepErrorText(res), 'Database setup failed');
    process.exit(1);
  }

  const probe = clack.spinner();
  probe.start('Checking this machine…');
  const det = await detectStep('database').catch(() => null);
  if (det?.local?.running) probe.stop(`Found Postgres on localhost:${det.local.port}${det.local.pgvectorAvailable ? ' (pgvector available)' : ''}.`);
  else if (det?.local?.installed) probe.stop('Postgres is installed but not running.');
  else probe.stop('No local Postgres detected — the built-in database needs nothing installed.');

  while (true) {
    const options = [];
    if (det?.embedded?.available !== false) {
      options.push({ value: 'embedded', label: 'Built-in database (recommended)', hint: 'No install — Postgres + pgvector run in-process at ~/.sigil/db' });
    }
    if (det?.local?.running) {
      options.push({ value: 'local', label: 'Connect to local Postgres', hint: `localhost:${det.local.port} — reuse your running server` });
    } else if (det?.local?.installed) {
      options.push({ value: 'local-start', label: 'Start & connect local Postgres', hint: 'Start your installed Postgres, then set up' });
    }
    if (det?.docker?.installed) {
      options.push({ value: 'docker', label: 'Spin up a Sigil container', hint: det.docker.running ? 'Docker — dedicated pgvector Postgres' : "Docker installed but not running — we'll start it" });
    }
    options.push({ value: 'url', label: 'External database', hint: 'Managed (Neon / Supabase / RDS) or a connection string' });

    const choice = guard(await clack.select({ message: 'Where should memory live?', options, initialValue: options[0].value }));

    let input;
    if (choice === 'embedded') {
      // PGlite is single-process; a running daemon already owns the engine.
      const pid = await detectRunningDaemon();
      if (pid) {
        clack.note(`A Sigil daemon is already running (pid ${pid}).\nThe built-in database is single-process — stop it first:\n  sigil daemon stop`, 'Daemon running');
        const retry = guard(await clack.confirm({ message: 'Pick a different database option?', initialValue: true }));
        if (!retry) { clack.cancel('Stop the daemon then re-run sigil init.'); process.exit(1); }
        continue;
      }
      input = { mode: 'embedded' };
    } else if (choice === 'local' || choice === 'local-start') {
      // The local provisioner connects as the OS admin user to create the sigil
      // database + role. An admin password is optional (trust auth is common on
      // localhost) — Enter to skip.
      const adminPassword = guard(await clack.password({
        message: `Postgres admin password for "${det.local.adminUser}" (Enter to skip if trust auth)`,
      }));
      input = {
        mode: 'local',
        action: choice === 'local-start' ? 'start' : 'connect',
        host: 'localhost',
        port: det.local.port,
        adminUser: det.local.adminUser,
        ...(adminPassword ? { adminPassword } : {}),
      };
    } else if (choice === 'docker') {
      input = { mode: 'docker' };
    } else {
      const url = guard(await clack.text({
        message: 'Postgres connection URL',
        placeholder: 'postgres://user:pass@host:5432/dbname',
        validate: (v) => { if (!/^postgres(ql)?:\/\//i.test(v || '')) return 'Must start with postgres:// or postgresql://'; },
      }));
      const proceed = guard(await clack.confirm({
        message: `Create the database & run migrations on ${hostOf(url)}?`,
        initialValue: true,
      }));
      if (!proceed) continue;
      input = { mode: 'url', url };
    }

    const res = await execStep(ctx.clack, runStep, 'database', input, {
      start: 'Setting up the database…',
      ok: (r) => {
        if (r.mode === 'embedded') return `Built-in database ready (${r.migrationsRan} migrations).`;
        if (r.mode === 'url') return `Database ready (${r.provider || 'external'}, ${r.migrationsRan} migrations).`;
        return `Database ready (${r.host}:${r.port}/${r.database}, ${r.migrationsRan} migrations).`;
      },
    });
    if (res.ok) return;
    clack.note(stepErrorText(res), 'Database setup failed');
    const again = guard(await clack.confirm({ message: 'Try a different database option?', initialValue: true }));
    if (!again) { clack.cancel('Setup cancelled.'); process.exit(1); }
  }
}

// ── 2 & 3. Provider steps (LLM + Embeddings) ──────────────────────────────────
const PROVIDER_COPY = {
  llm: { select: 'LLM provider (classifies input, extracts facts, answers searches)', start: 'Saving + testing a live LLM call…', ok: 'LLM provider ready.' },
  embedding: { select: 'Embedding provider (powers semantic search — pinned to 1024-dim)', start: 'Saving + testing an embed call…', ok: 'Embedder ready.' },
};

/** Synthesize the input fields for a provider, mirroring the GUI's providerFields. */
function providerFields(stepId, p) {
  if (stepId === 'llm') return { fields: p.fields || [], note: '' };
  // embedding: derive from flags
  const fields = [];
  let note = '';
  if (p.keyed && !p.sharedKeyAvailable) fields.push({ name: 'apiKey', label: `${p.label} API key`, type: 'password', placeholder: 'paste key' });
  else if (p.keyed && p.sharedKeyAvailable) note = 'Reuses the API key from your LLM step.';
  if (p.id === 'ollama') fields.push({ name: 'host', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434', optional: true });
  return { fields, note };
}

async function runProviderStep(ctx, stepId) {
  const { clack, guard, runStep, detectStep } = ctx;
  const copy = PROVIDER_COPY[stepId];

  while (true) {
    const det = await detectStep(stepId).catch(() => ({ providers: [] }));
    const providers = det.providers || [];
    const rec = providers.find((p) => p.recommended) || providers[0];

    const choice = guard(await clack.select({
      message: copy.select,
      options: providers.map((p) => ({ value: p.id, label: p.label + (p.recommended ? ' (recommended)' : ''), hint: p.hint })),
      initialValue: rec?.id,
    }));
    const p = providers.find((x) => x.id === choice);

    const { fields, note } = providerFields(stepId, p);
    if (note) clack.log.info(note);
    const input = { provider: choice, ...(await collectFields(clack, guard, fields)) };

    // Ollama embeddings: pick a compatible (1024-dim) model from the live list;
    // apply() pulls it if it isn't installed yet.
    if (stepId === 'embedding' && choice === 'ollama') {
      const models = det.ollama?.models || [];
      if (models.length) {
        input.model = guard(await clack.select({
          message: 'Ollama embedding model',
          options: models.map((m) => ({ value: m.name, label: m.name + (m.recommended ? ' (recommended)' : ''), hint: m.installed ? 'installed' : `pull ${m.size || ''}`.trim() })),
          initialValue: models.find((m) => m.installed)?.name || models.find((m) => m.recommended)?.name || det.ollama.recommended,
        }));
      }
    }

    const res = await execStep(clack, runStep, stepId, input, { start: copy.start, ok: copy.ok });
    if (res.ok) {
      if (res.result?.staleFacts) clack.log.warn('Some existing facts use a different model — run `sigil repair embeddings` so they rank correctly.');
      return;
    }
    clack.note(stepErrorText(res), `${copy.select.split(' ')[0]} step failed`);
    const again = guard(await clack.confirm({ message: 'Try again with different settings?', initialValue: true }));
    if (!again) { clack.cancel('Setup cancelled.'); process.exit(1); }
  }
}

// ── 4. Coding agents (connectors) ─────────────────────────────────────────────
async function stepConnectors(ctx) {
  const { clack, guard, runStep } = ctx;
  const { listClients } = await import('../lib/clients/index.js');
  const clients = await listClients();
  const detected = await Promise.all(clients.map((c) => c.detect().catch(() => false)));
  const detectedIds = clients.filter((_, i) => detected[i]).map((c) => c.id);

  const picked = guard(await clack.multiselect({
    message: 'Connect your coding agents (space to toggle, Enter to confirm)',
    options: clients.map((c, i) => ({ value: c.id, label: c.label, hint: detected[i] ? `${c.hint} — detected` : c.hint })),
    initialValues: detectedIds.length ? detectedIds : ['claude-code'],
    required: false,
  }));

  for (const id of picked) {
    const c = clients.find((x) => x.id === id);
    const s = clack.spinner();
    s.start(`Connecting ${c.label}…`);
    try {
      await c.install({ dryRun: false });
      const v = await c.verify().catch((e) => ({ installed: false, reason: e?.message }));
      if (!v?.installed) throw new Error(v?.reason || 'verification failed');
      s.stop(`${c.label} connected`);
    } catch (err) {
      s.stop(`${c.label} failed: ${err.message}`);
    }
  }

  // Refresh the hot-context snapshot so a new session sees memory immediately.
  const { updateContextSnapshot } = await import('../memory/facts/hot-context.js');
  await updateContextSnapshot().catch(() => {});

  // Mark the step done in config.json (connecting any number — including zero — is fine).
  await runStep('connectors', {});
}

// ── 5. Your name (identity) ───────────────────────────────────────────────────
async function stepIdentity(ctx) {
  const { clack, guard, runStep } = ctx;
  while (true) {
    const name = guard(await clack.text({
      message: 'What should we call you? (saved as your first memory — a live full-stack test)',
      placeholder: 'e.g. Anmol',
      validate: (v) => {
        const t = String(v || '').trim();
        if (!t) return 'Tell us what to call you';
        if (t.length > 80) return 'That name is too long';
      },
    }));
    const res = await execStep(clack, runStep, 'identity', { name: name.trim() }, {
      start: 'Saving + writing your first memory (testing the whole stack)…',
      ok: (r) => `First memory written as “${r.name}”.`,
    });
    if (res.ok) return;
    clack.note(stepErrorText(res), 'Could not write the first memory');
    const again = guard(await clack.confirm({ message: 'Try again?', initialValue: true }));
    if (!again) { clack.cancel('Setup cancelled.'); process.exit(1); }
  }
}

// ── entrypoint ────────────────────────────────────────────────────────────────
export async function runInit(args = []) {
  if (args.includes('--help') || args.includes('-h')) return printHelp();

  const urlFlagIdx = args.findIndex((a) => a === '--url' || a.startsWith('--url='));
  let urlFlag = null;
  if (urlFlagIdx !== -1) {
    const tok = args[urlFlagIdx];
    urlFlag = tok.includes('=') ? tok.split('=').slice(1).join('=') : args[urlFlagIdx + 1];
    if (!urlFlag) { console.error('--url requires a Postgres connection string'); process.exit(1); }
  }

  const clack = await import('@clack/prompts');
  const guard = (v) => { if (clack.isCancel(v)) { clack.cancel('Setup cancelled.'); process.exit(0); } return v; };

  clack.intro('Sigil — persistent memory for your AI agents');

  // Refuse to set up from an ephemeral `pnpm dlx` / `npx` cache before touching
  // anything — baking that path into hooks would silently break later and cold-
  // boot a process per fire. (Authoritatively re-checked at shim write.)
  const { ephemeralPackageRoot } = await import('../lib/paths.js');
  const ephemeral = ephemeralPackageRoot();
  if (ephemeral.ephemeral) {
    const { ephemeralInstallMessage } = await import('../lib/clients/shim.js');
    clack.cancel(ephemeralInstallMessage(ephemeral));
    process.exit(1);
  }

  // The exact same engine the GUI drives over RPC. Steps persist to config.json.
  const { runStep, detectStep, getSetupState, getSetupConfig } = await import('../setup/service.js');
  const ctx = { clack, guard, runStep, detectStep };

  await stepDatabase(ctx, { urlFlag });
  await runProviderStep(ctx, 'llm');
  await runProviderStep(ctx, 'embedding');
  await stepConnectors(ctx);
  await stepIdentity(ctx);

  const state = getSetupState();
  const cfg = getSetupConfig();
  const dbLine = cfg.database.mode === 'url'
    ? `Database      ${cfg.database.urlHost || 'external'} (connection URL)`
    : cfg.database.mode === 'embedded'
      ? 'Database      built-in (PGlite — ~/.sigil/db)'
      : `Database      ${cfg.database.host}:${cfg.database.port}/${cfg.database.name}`;

  clack.note(
    [
      dbLine,
      `LLM           ${cfg.llm.provider}${cfg.llm.model ? ` (${cfg.llm.model})` : ''}`,
      `Embeddings    ${cfg.embedding.provider}/${cfg.embedding.model} · ${cfg.embedding.dim}d`,
      `You           ${cfg.identity.name}`,
      `Config        ~/.sigil/config.json`,
      '',
      'Your AI agents will search Sigil before answering and save important',
      'facts automatically. Open a new session to begin.',
      '',
      'Quick start:',
      '  sigil remember "your first fact"',
      '  sigil search "anything"',
      '  sigil            (open the dashboard)',
    ].join('\n'),
    state.complete ? 'Setup complete' : 'Setup saved (some steps still pending)',
  );

  clack.outro(state.complete ? 'Sigil is ready.' : 'Finish the remaining steps with `sigil` (dashboard) or re-run `sigil init`.');

  // The shared cortexDb pool (opened by the DB/embedder/identity steps) keeps
  // connections alive and would hang the event loop. All DB work is done — exit
  // explicitly, matching the pattern across the CLI.
  process.exit(state.complete ? 0 : 1);
}

function printHelp() {
  console.log(`sigil init — Interactive first-run setup (Database, LLM, Embeddings, agents, name)

Usage:
  sigil init [--url <postgres-url>]

Drives the same setup engine as the web dashboard and writes everything to
~/.sigil/config.json (no .env). Walks you through five steps:

  1. Database     Built-in (PGlite, zero install) · local Postgres · Docker · external URL
  2. LLM provider Claude Code · OpenRouter · OpenAI · Anthropic · Ollama
  3. Embeddings   OpenAI · Voyage · OpenRouter · Ollama  (all pinned to 1024-dim)
  4. Coding agents Connect Claude Code / Cursor / Codex / Kiro / Hermes (memory hooks)
  5. Your name    Stored + written as your first memory (verifies the whole stack)

Options:
  --url <url>   Skip the database picker and use this Postgres connection string
                (Neon, Supabase, RDS, self-hosted). The database is created if
                missing, pgvector enabled, and migrations applied.

Prefer a GUI? Run \`sigil\` to open the same wizard in your browser.`);
  process.exit(0);
}
