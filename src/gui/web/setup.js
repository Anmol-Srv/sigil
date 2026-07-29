/**
 * Native first-run setup — GUI controller.
 *
 * Drives the daemon's setup service (setup.state / setup.detect / setup.run)
 * and renders a stepped progress bar fed by live { type:'setup' } events on the
 * /api/v1/events WebSocket. No terminal logs: every step shows a progress bar +
 * a single error slot.
 *
 * Required setup: Database → memory search. Coding-agent connections and an
 * optional LLM are offered after the core is ready; neither blocks local CLI or
 * MCP memory use.
 */
import { rpc } from './api.js';
import { toast } from './toast.js';
import { connectorCard } from './components.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEP_DESC = {
  database: 'Where memory lives',
  llm: 'Optional fact extraction',
  embedding: 'Find related memories',
  connectors: 'Optional integrations',
};

const AGENT_SETUP_PROMPT = `Set up Sigil on this machine through the terminal. If Sigil is not installed, use the official installer:\n\ncurl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh\n\nThen run \`sigil init\`. Default to Sigil's built-in local database unless I explicitly ask to use an existing, Docker, or external Postgres database. Explain each provider choice in plain language. Use an embedding provider that is already configured, or ask me to provide its key without printing it. Connect only coding agents you detect. Do not install or download Ollama or models automatically. Finish with \`sigil doctor\` and report whether storage and memory search are healthy. Do not delete, reset, or overwrite existing Sigil data.`;

let state = null;
let busy = false;
let ws = null;
let viewStep = null;     // the step currently shown (may be earlier than currentStep via Back)

// per-step selection scratch
let dbDetect = null;
let selectedMode = null;
let selectedExtra = {};
let providers = [];      // current step's provider list
let selectedProvider = null;

export async function initSetup() {
  try {
    state = await rpc('setup.state', {}, { quiet: true });
  } catch {
    hide();
    return false;
  }
  if (state.complete) { hide(); return false; }
  show();
  connectWs();
  renderRail();
  await enterStep(state.currentStep || 'database');
  return true;
}

function show() { const el = $('#setup'); if (el) el.hidden = false; document.body.classList.add('in-setup'); }
function hide() { const el = $('#setup'); if (el) el.hidden = true; document.body.classList.remove('in-setup'); }

function connectWs() {
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/v1/events`);
  ws.addEventListener('message', (e) => {
    try { const evt = JSON.parse(e.data); if (evt.type === 'setup') onSetupEvent(evt); } catch { /* */ }
  });
  ws.addEventListener('close', () => { if (!$('#setup')?.hidden) setTimeout(connectWs, 1500); });
}

// ── left rail ────────────────────────────────────────────────────────────────
function railClass(s) {
  if (s.id === viewStep) return 'active';
  if (s.status === 'done') return 'done';
  return 'future';
}
function renderRail() {
  const host = $('#setup-rail'); if (!host) return;
  host.innerHTML = state.steps.filter((s) => s.id !== 'llm').map((s, i) => `
    <li class="onboarding-step ${railClass(s)}" data-setup-step="${esc(s.id)}">
      <div class="num">${s.status === 'done' ? '✓' : i + 1}</div>
      <div>
        <div class="label">${esc(s.title)}</div>
        <div class="desc">${esc(STEP_DESC[s.id] || '')}${s.implemented ? '' : ' · soon'}</div>
      </div>
    </li>`).join('');
}

// ── shared scaffolding every step renders into #setup-main ───────────────────
function shell({ title, lede, body }) {
  const order = (state?.steps || []).filter((s) => s.id !== 'llm').map((s) => s.id);
  const idx = order.indexOf(viewStep);
  const canBack = idx > 0;
  $('#setup-main').innerHTML = `
    <h1>${esc(title)}</h1>
    <p class="lede">${lede}</p>
    ${body}
    <div id="setup-confirm"></div>
    <div class="wizard-actions">
      <button class="btn ghost" id="setup-back"${canBack ? '' : ' hidden'}>← Back</button>
      <div class="spacer"></div>
      <button class="btn primary large" id="setup-run" disabled>${esc(title.startsWith('What') || viewStep === 'connectors' ? 'Finish setup' : 'Continue')}</button>
    </div>
    <div id="setup-progress" class="setup-progress" hidden>
      <div class="setup-progress-bar"><span id="setup-progress-fill"></span></div>
      <div id="setup-progress-label" class="setup-progress-label"></div>
    </div>
    <div id="setup-error" class="result err" hidden></div>`;
  if (canBack) $('#setup-back').addEventListener('click', () => { if (!busy) enterStep(order[idx - 1]); });
}

function fieldInputs(fields, sharedNote) {
  const note = sharedNote ? `<p class="muted text-sm">${esc(sharedNote)}</p>` : '';
  if (!fields.length) return note || '<p class="muted text-sm">No additional configuration needed.</p>';
  return note + fields.map((f) => `
    <label class="field">
      <span class="label">${esc(f.label)}${f.optional ? ' <span class="muted text-xs">(optional)</span>' : ''}</span>
      <input type="${esc(f.type)}" data-setup-field="${esc(f.name)}"${f.optional ? ' data-optional="1"' : ''} placeholder="${esc(f.placeholder || '')}" autocomplete="off">
    </label>`).join('');
}

// Enable Continue only when every non-optional field has a value (so e.g. an
// OpenRouter model isn't optional). No fields → enabled (claude-cli).
function wireRequiredGate() {
  const inputs = [...$$all('#setup-fields [data-setup-field]')];
  const sync = () => {
    const ok = inputs.every((i) => i.dataset.optional === '1' || i.value.trim());
    const btn = $('#setup-run'); if (btn) btn.disabled = !ok;
  };
  inputs.forEach((i) => i.addEventListener('input', sync));
  sync();
}

function collectFields() {
  const out = {};
  $$all('#setup-fields [data-setup-field]').forEach((i) => { if (i.value) out[i.dataset.setupField] = i.value; });
  return out;
}
const $$all = (s, r = document) => r.querySelectorAll(s);

// ── dispatch ─────────────────────────────────────────────────────────────────
async function enterStep(stepId) {
  viewStep = stepId;
  renderRail();
  if (stepId === 'database') return renderDatabaseStep();
  if (stepId === 'llm') return renderProviderStep('llm');
  if (stepId === 'embedding') return renderProviderStep('embedding');
  if (stepId === 'connectors') return renderConnectorsStep();
  renderComingSoon();
}

function renderComingSoon() {
  $('#setup-main').innerHTML = `<h1>Setup complete.</h1><p class="lede">Opening the dashboard…</p>`;
}

// ── Database step (mode cards) ───────────────────────────────────────────────
async function renderDatabaseStep() {
  shell({
    title: 'Keep memory on this machine.',
    lede: 'Start with Sigil’s built-in database. It needs no server and keeps memory at ~/.sigil/db. If you already operate Postgres or need a remote database for this VM, you can choose that instead.',
    body: `<div id="setup-detect" class="setup-detect muted">Checking this machine…</div>
      <div class="provider-card-grid" id="setup-db-modes"></div>
      <details class="setup-advanced" id="setup-db-advanced"><summary>Use another database</summary><div class="provider-card-grid" id="setup-db-alternatives"></div></details>
      <div id="setup-fields" hidden></div>`,
  });
  $('#setup-run').addEventListener('click', runDatabase);
  addAgentAssist();
  dbDetect = await rpc('setup.detect', { step: 'database' }, { quiet: true }).catch(() => null);
  renderDbModes();
}

function renderDbModes() {
  const det = dbDetect || { embedded: {}, local: {}, docker: {} };
  const s = $('#setup-detect');
  if (det.local?.running) s.innerHTML = `Found Postgres on <b>localhost:${det.local.port}</b> — pgvector ${det.local.pgvectorAvailable ? '<b>available ✓</b>' : '<b>not available</b>'}. The built-in database needs nothing installed.`;
  else if (det.local?.installed) s.innerHTML = 'Postgres is installed but not running. The built-in database needs nothing installed.';
  else s.innerHTML = 'No local Postgres detected — the built-in database below needs nothing installed.';

  const defaultCards = [];
  const alternativeCards = [];
  // Embedded (PGlite) — the zero-prerequisite default. Always available: a full
  // Postgres 17 + pgvector compiled to WASM, running in-process under ~/.sigil/db.
  if (det.embedded?.available !== false) {
    defaultCards.push(card('mode', 'embedded',
      'Use the built-in database <span class="badge info" style="margin-left:var(--s-2);">RECOMMENDED</span>',
      'No install — Postgres + pgvector run inside Sigil, stored at ~/.sigil/db'));
  }
  if (det.local?.running) alternativeCards.push(card('mode', 'local', 'Connect to local Postgres', `localhost:${det.local.port} · reuse your running server`, { action: 'connect' }));
  else if (det.local?.installed) alternativeCards.push(card('mode', 'local', 'Start &amp; connect local Postgres', 'Start your installed Postgres, then set up', { action: 'start' }));
  if (det.docker?.installed) {
    const hint = det.docker.running
      ? 'Docker — dedicated pgvector Postgres, zero setup'
      : "Docker is installed but not running — we'll start it for you";
    alternativeCards.push(card('mode', 'docker', 'Spin up a Sigil container', hint));
  } else {
    alternativeCards.push(cardDisabled('Spin up a Sigil container', det.docker?.reason || 'Docker not installed'));
  }
  alternativeCards.push(card('mode', 'url', 'External database', 'Managed (Neon / Supabase / RDS) or a connection string'));

  $('#setup-db-modes').innerHTML = defaultCards.join('');
  $('#setup-db-alternatives').innerHTML = alternativeCards.join('');
  $$all('#setup [data-mode]').forEach((c) => c.addEventListener('click', () => {
    selectedMode = c.dataset.mode;
    selectedExtra = JSON.parse(c.dataset.extra || '{}');
    $$all('#setup [data-mode]').forEach((x) => x.classList.toggle('selected', x === c));
    const fields = selectedMode === 'url' ? [{ name: 'url', label: 'Connection string', type: 'text', placeholder: 'postgres://user:pass@host:5432/dbname' }] : [];
    const host = $('#setup-fields');
    host.hidden = fields.length === 0;
    host.innerHTML = fieldInputs(fields);
    wireRequiredGate();
  }));
  $('#setup-db-modes [data-mode="embedded"]')?.click();
}

async function runDatabase() {
  if (busy || !selectedMode) return;
  const input = { mode: selectedMode, ...selectedExtra, ...collectFields() };
  if (selectedMode === 'url') {
    if (!input.url) { showError('Enter a connection string.', null); return; }
    if (!(await confirmExternal(input.url))) return;
  } else if (selectedMode === 'local' && dbDetect?.local) {
    input.host = 'localhost';
    input.port = dbDetect.local.port;
    input.adminUser = dbDetect.local.adminUser;
  }
  runStep('database', input);
}

function confirmExternal(url) {
  return new Promise((resolve) => {
    const host = (() => { try { return new URL(url).host; } catch { return 'that server'; } })();
    const el = $('#setup-confirm');
    el.innerHTML = `<div class="result">
      <strong>Create database &amp; run migrations on ${esc(host)}?</strong>
      <div class="muted" style="margin:6px 0;">Sigil will create the database if missing, enable pgvector, and apply its schema.</div>
      <div class="flex-row" style="margin-top:8px;">
        <button type="button" class="btn primary" data-yes>Continue</button>
        <button type="button" class="btn" data-no>Cancel</button>
      </div></div>`;
    el.querySelector('[data-yes]').addEventListener('click', () => { el.innerHTML = ''; resolve(true); });
    el.querySelector('[data-no]').addEventListener('click', () => { el.innerHTML = ''; resolve(false); });
  });
}

function addAgentAssist() {
  const host = $('#setup-main');
  const block = document.createElement('div');
  block.className = 'setup-agent-assist';
  block.innerHTML = `<div><strong>Let your coding agent handle setup</strong><p class="muted text-sm">Copy a guarded prompt that uses the same installer, keeps the local default, and asks before any credentials or destructive action.</p></div><button type="button" class="btn" id="setup-copy-agent">Copy agent prompt</button>`;
  host.querySelector('#setup-confirm').before(block);
  block.querySelector('#setup-copy-agent').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await copyText(AGENT_SETUP_PROMPT);
      button.textContent = 'Copied';
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy agent prompt'; }, 1600);
    } catch {
      toast({ variant: 'error', message: 'Could not copy the prompt. Select it from the Sigil README instead.' });
    }
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
}

// ── LLM + Embedding steps (provider cards) ───────────────────────────────────
const PROVIDER_COPY = {
  llm: { title: 'Choose an optional LLM provider.', lede: 'An LLM is only used when you explicitly extract facts from a document. Storage and search work without one.' },
  embedding: { title: 'Set up memory search.', lede: 'Sigil needs one embedding provider to find related memories. Choose a provider you already use; its key stays only in your local Sigil configuration.' },
};

async function renderProviderStep(stepId) {
  const copy = PROVIDER_COPY[stepId];
  shell({ title: copy.title, lede: copy.lede, body: `<div class="provider-card-grid" id="setup-providers"></div><div id="setup-fields"></div>` });
  $('#setup-run').addEventListener('click', () => runProviderStep(stepId));
  if (stepId === 'llm') addLlmSkip();
  const det = await rpc('setup.detect', { step: stepId }, { quiet: true }).catch(() => ({ providers: [] }));
  providers = det.providers || [];
  $('#setup-providers').innerHTML = providers.map((p) => p.available === false
    ? cardDisabled(p.label, p.hint)
    : card('prov', p.id, `${esc(p.label)}${p.recommended ? ' <span class="badge info" style="margin-left:var(--s-2);">RECOMMENDED</span>' : ''}`, p.hint)).join('');
  $$all('#setup-providers [data-prov]').forEach((c) => c.addEventListener('click', () => selectProvider(stepId, c.dataset.prov)));
  const rec = providers.find((p) => p.recommended) || providers[0];
  if (rec) selectProvider(stepId, rec.id);
}

function providerFields(stepId, p) {
  if (stepId === 'llm') return { fields: p.fields || [], note: '' };
  // embedding: synthesize fields from flags
  const fields = [];
  let note = '';
  if (p.keyed && !p.sharedKeyAvailable) fields.push({ name: 'apiKey', label: `${p.label} API key`, type: 'password', placeholder: 'paste key' });
  else if (p.keyed && p.sharedKeyAvailable) note = 'Reuses the API key from your LLM step.';
  if (p.id === 'ollama') fields.push({ name: 'host', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434', optional: true });
  return { fields, note };
}

function selectProvider(stepId, id) {
  selectedProvider = id;
  $$all('#setup-providers [data-prov]').forEach((c) => c.classList.toggle('selected', c.dataset.prov === id));
  const p = providers.find((x) => x.id === id);
  const { fields, note } = providerFields(stepId, p);
  $('#setup-fields').innerHTML = fieldInputs(fields, note);
  wireRequiredGate();
  // OpenRouter exposes a public model list — turn the free-text model field
  // into an autocomplete picker (datalist) while still allowing a typed value.
  if (stepId === 'llm' && id === 'openrouter') attachModelPicker();
}

let orModels = [];
async function attachModelPicker() {
  const input = $('#setup-fields [data-setup-field="model"]');
  if (!input) return;
  // Fetch OpenRouter's PUBLIC model list directly from the browser (no key, no
  // daemon round-trip — the endpoint sends Access-Control-Allow-Origin: *).
  input.placeholder = 'loading models…';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    orModels = (data.data || [])
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (selectedProvider !== 'openrouter' || !document.body.contains(input)) return;
    if (!orModels.length) { input.placeholder = 'e.g. google/gemini-flash-latest'; return; }
    input.placeholder = `search ${orModels.length} models…`;
    buildModelCombo(input);
  } catch {
    if (selectedProvider === 'openrouter') input.placeholder = 'e.g. google/gemini-flash-latest (list unavailable — type a model id)';
  }
}

// A real searchable dropdown (the native <datalist> doesn't filter reliably
// and rendered badly with hundreds of options). Absolutely-positioned, scrolls,
// filters as you type, click to choose.
function buildModelCombo(input) {
  const field = input.closest('.field') || input.parentElement;
  field.classList.add('combo');
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.hidden = true;
  input.after(list);

  let selecting = false;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const matches = (q ? orModels.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : orModels).slice(0, 100);
    list.innerHTML = matches.length
      ? matches.map((m) => `<li data-val="${esc(m.id)}"><span class="combo-id">${esc(m.id)}</span><span class="combo-name">${esc(m.name)}</span></li>`).join('')
      : '<li class="combo-empty">no match — type a custom model id</li>';
  };
  const open = () => { render(); list.hidden = false; };
  const close = () => { list.hidden = true; };

  input.addEventListener('focus', open);
  input.addEventListener('input', () => { if (!selecting) open(); });
  // mousedown (not click) so it fires before the input's blur.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-val]');
    if (!li) return;
    e.preventDefault();
    selecting = true;
    input.value = li.dataset.val;
    input.dispatchEvent(new Event('input', { bubbles: true })); // re-evaluates the required gate
    selecting = false;
    close();
  });
  document.addEventListener('click', (e) => { if (!field.contains(e.target)) close(); });
}

function runProviderStep(stepId) {
  if (busy || !selectedProvider) return;
  runStep(stepId, { provider: selectedProvider, ...collectFields() });
}

// ── Connectors step (multi-toggle list) ──────────────────────────────────────
async function renderConnectorsStep() {
  shell({
    title: 'Connect your coding agents (optional).',
    lede: 'Connect the AI tools you use so they can recall Sigil memory. You can skip this, keep using the CLI or MCP directly, and connect tools later from Settings.',
    body: '<div class="connector-grid" id="setup-connectors"><div class="muted">detecting installed tools…</div></div>',
  });
  // Connectors are optional — Continue is always enabled.
  $('#setup-run').disabled = false;
  $('#setup-run').addEventListener('click', () => runStep('connectors', {}));
  await loadSetupConnectors();
}

async function loadSetupConnectors() {
  const host = $('#setup-connectors');
  if (!host) return;
  try {
    const { connectors } = await rpc('listConnectors');
    host.innerHTML = '';
    if (!connectors.length) { host.innerHTML = '<div class="muted">no agents detected on this machine</div>'; return; }
    connectors.forEach((c) => host.appendChild(connectorCard(c, onSetupConnectorAction)));
  } catch (err) {
    host.innerHTML = `<div class="muted">could not load agents: ${esc(err.message)}</div>`;
  }
}

async function onSetupConnectorAction(id, action) {
  const host = $('#setup-connectors');
  const card = host?.querySelector(`[data-id="${id}"]`);
  if (action === 'disconnect') {
    try { await rpc('disconnectConnector', { id }); toast({ variant: 'success', message: `${id} disconnected` }); }
    catch (err) { toast({ variant: 'error', message: err.message, hint: err.hint, code: err.code }); }
    return loadSetupConnectors();
  }
  // connect / retry
  if (card) card.replaceWith(connectorCard({ id, label: id, hint: '', uiState: 'connecting' }, onSetupConnectorAction));
  try { await rpc('connectConnector', { id }); toast({ variant: 'success', message: `${id} connected` }); }
  catch (err) { toast({ variant: 'error', message: err.message || `could not connect ${id}`, hint: err.hint, code: err.code }); }
  return loadSetupConnectors();
}

// ── shared run + progress ────────────────────────────────────────────────────
async function runStep(stepId, input) {
  if (busy) return;
  startBusy();
  try {
    const res = await rpc('setup.run', { step: stepId, input }, { quiet: true });
    if (res.ok) { setProgress(100, 'Done.'); await onStepDone(stepId); }
    else showError(res.error || (res.errors && Object.values(res.errors)[0]) || 'Setup failed.', res.hint);
  } catch (err) {
    showError(err.message, err.hint);
  } finally {
    endBusy();
  }
}

function startBusy() { busy = true; $('#setup-run').disabled = true; $('#setup-error').hidden = true; $('#setup-progress').hidden = false; setProgress(0, 'Starting…'); }
function endBusy() { busy = false; const b = $('#setup-run'); if (b) b.disabled = false; }
function setProgress(pct, label) {
  const f = $('#setup-progress-fill'); if (f) f.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  const l = $('#setup-progress-label'); if (l) l.textContent = label || '';
}
function showError(message, hint) {
  const el = $('#setup-error'); if (!el) return;
  el.hidden = false;
  el.innerHTML = `✗ ${esc(message)}${hint ? `<div class="muted" style="margin-top:4px;">→ ${esc(hint)}</div>` : ''}`;
  $('#setup-progress').hidden = true;
}

async function onStepDone(completedStep) {
  state = await rpc('setup.state', {}, { quiet: true }).catch(() => state);
  renderRail();
  if (completedStep === 'embedding' && state.complete && state.steps.some((step) => step.id === 'connectors' && step.status !== 'done')) {
    await enterStep('connectors');
    return;
  }
  if (completedStep === 'connectors' && state.complete && state.steps.some((step) => step.id === 'llm' && step.status !== 'done')) {
    renderOptionalLlmOffer();
    return;
  }
  if (state.complete) { finishOnboarding(); return; }
  await enterStep(state.currentStep || null);
}

function renderOptionalLlmOffer() {
  viewStep = 'llm-offer';
  renderRail();
  shell({
    title: 'Add optional document fact extraction?',
    lede: 'Storage and memory search are ready. An LLM only helps when you explicitly ask Sigil to extract atomic facts from a document.',
    body: `<div class="result"><strong>Use it when you want decision logs, runbooks, or long notes distilled into searchable facts.</strong><div class="muted" style="margin-top:6px;">It never runs during ordinary saves, searches, or document ingestion unless you opt in with <code>--extract-facts</code>.</div><div class="flex-row" style="margin-top:12px;"><button type="button" class="btn" id="setup-add-llm">Configure an LLM</button></div></div>`,
  });
  const finish = $('#setup-run');
  finish.disabled = false;
  finish.textContent = 'Not now, finish setup';
  finish.addEventListener('click', finishOnboarding);
  $('#setup-add-llm').addEventListener('click', () => enterStep('llm'));
}

function addLlmSkip() {
  const host = $('#setup-confirm');
  host.innerHTML = '<button type="button" class="btn ghost" id="setup-skip-llm">Not now</button>';
  $('#setup-skip-llm').addEventListener('click', finishOnboarding);
}

function finishOnboarding() {
  toast({ variant: 'success', message: 'Setup complete.' });
  setTimeout(() => window.location.reload(), 700);
}

function onSetupEvent(evt) {
  if (evt.status === 'active') setProgress(evt.pct ?? 0, evt.label || '');
  else if (evt.status === 'error') showError(evt.label || 'Setup failed.', evt.hint);
}

// ── card helpers ──────────────────────────────────────────────────────────────
function card(kind, id, name, hint, extra = {}) {
  return `<label class="provider-card" data-${kind}="${esc(id)}" data-extra='${esc(JSON.stringify(extra))}'>
    <span class="check"></span><span class="name">${name}</span><span class="hint">${esc(hint)}</span>
  </label>`;
}
function cardDisabled(name, why) {
  return `<label class="provider-card disabled" title="${esc(why)}">
    <span class="check"></span><span class="name">${esc(name)}</span><span class="hint">${esc(why)}</span>
  </label>`;
}
