// Sigil GUI — vanilla JS. Onboarding wizard + dashboard.
import { toast } from './toast.js';
import { connectorCard } from './components.js';
import { initSetup } from './setup.js';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ── RPC ──────────────────────────────────────────────────────────────
async function rpc(method, params = {}) {
  const res = await fetch('/api/v1/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) {
    const e = body.error || {};
    throw Object.assign(new Error(e.message || 'rpc error'), { code: e.code, hint: e.hint });
  }
  return body.data;
}

// ── Helpers ──────────────────────────────────────────────────────────
const escape = (v) => {
  if (v === null || v === undefined) return '—';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
};
const formatUptime = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
};
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); return true; }
    catch { return false; }
    finally { document.body.removeChild(ta); }
  }
}

// ════════════════════════════════════════════════════════════════════
// DASHBOARD (unchanged behavior)
// ════════════════════════════════════════════════════════════════════
function setConn(state, label) {
  const el = $('#conn');
  el.className = `conn-status ${state}`;
  el.textContent = label;
}
function renderKv(node, entries) {
  node.innerHTML = entries.map(([k, v]) => `<div class="row"><div class="k">${escape(k)}</div><div class="v">${escape(v)}</div></div>`).join('');
}

const validRoutes = ['health', 'kb', 'agents', 'activity', 'settings'];
const ROUTE_TITLES = {
  health: 'Home', kb: 'Knowledge Base', agents: 'Agents',
  activity: 'Activity', settings: 'Settings',
};
function setRoute(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('nav a').forEach((a) => {
    const on = a.dataset.route === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const h1 = $('#route-title');
  if (h1) h1.textContent = ROUTE_TITLES[name] || 'Sigil';
  window.location.hash = name;
  if (name === 'health')   refreshHealth();
  if (name === 'kb')       refreshKb();
  if (name === 'settings') { refreshEnv(); refreshRuntime(); }
  if (name === 'agents')   refreshAgents();
  if (name === 'activity') { ensureActivityWs(); loadTraces(); }
}
function routeFromHash() {
  const r = (window.location.hash || '#health').slice(1);
  return validRoutes.includes(r) ? r : 'health';
}
window.addEventListener('hashchange', () => setRoute(routeFromHash()));
$$('nav a').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); setRoute(a.dataset.route); });
});
$('#home-refresh')?.addEventListener('click', refreshHealth);
$('#agents-refresh')?.addEventListener('click', refreshAgents);

const fmtNum = (x) => (typeof x === 'number' ? x.toLocaleString() : '—');

async function refreshHealth() {
  try {
    const [ping, status] = await Promise.all([
      rpc('ping'),
      rpc('status', {}).catch(() => ({})),
    ]);

    // ── stat strip: user concepts, not document-ingestion internals ──
    // `remember` writes atomic facts directly, so it correctly produces no
    // documents or chunks. Document passages remain a detail of source
    // ingestion rather than a headline metric.
    $('#hm-facts').textContent = fmtNum(status.facts);
    $('#hm-documents').textContent = fmtNum(status.documents);
    $('#brand-badge').textContent = 'local';

    // ── diagnostics drawer: the daemon plumbing, demoted ──
    const rows = [
      ['daemon pid', ping.pid], ['version', ping.version], ['node.js', ping.node],
      ['uptime', formatUptime(ping.uptimeMs)], ['storage', 'local-first'],
    ];
    renderKv($('#health-pane'), rows);

    $('#footer-version').textContent = `v${ping.version}`;
    $('#footer-pid').textContent = ping.pid;

    setConn('ok', 'connected');
  } catch (err) { setConn('err', err.message); }

  // Recent durable-write activity is independent of the daemon ping.
  loadHomeActivity();
}

async function loadHomeActivity() {
  let traces;
  try { ({ traces } = await rpc('trace.list', { limit: 50 })); } catch { return; }

  const feed = $('#hm-feed');
  feed.innerHTML = traces.length
    ? traces.slice(0, 6).map(homeFeedRow).join('')
    : '<li class="muted text-sm">no saved-memory activity yet — remember a fact or ingest a source</li>';
}

function homeFeedRow(t) {
  const agent = t.agent ? `<span class="badge ${agentBadge(t.agent)}">${escape(t.agent)}</span>` : '';
  return `<li class="home-feed-row">
    <span class="badge ${traceBadge(t.kind)}">${escape(t.kind)}</span>
    <span class="home-feed-summary">${escape(t.summary)}</span>
    ${agent}
    <span class="home-feed-time">${escape(clock(t.ts))}</span>
  </li>`;
}

// ── Home: real memory search ───────────────────────────────────────
// This is deliberately submit-only: each query performs an embedding request
// and deterministic hybrid search, so typeahead would spend provider work on
// half-written questions. The request id prevents a slower earlier result from
// replacing a newer search.
const homeSearch = { requestId: 0, busy: false };

function homeSearchSetResults(html = '', state = '') {
  const node = $('#home-search-results');
  const clear = $('#home-search-clear');
  if (!node || !clear) return;
  node.hidden = !html;
  node.className = `home-search-results${state ? ` ${state}` : ''}`;
  node.innerHTML = html;
  clear.hidden = !html || homeSearch.busy;
}

function homeSearchResultRow(item, kind) {
  const isFact = kind === 'fact';
  const tags = isFact
    ? [item.category, item.confidence].filter(Boolean)
    : [item.sectionHeading].filter(Boolean);
  const label = isFact ? 'Memory' : 'Source';
  const rawContent = String(item.content || '').trim();
  const content = rawContent.length > 520 ? `${rawContent.slice(0, 517).trimEnd()}…` : rawContent;
  return `<article class="home-search-match">
    <div class="home-search-match-meta">
      <span class="badge ${isFact ? 'ok' : 'info'}">${label}</span>
      ${tags.map((tag) => `<span>${escape(tag)}</span>`).join('')}
    </div>
    <p>${escape(content)}</p>
  </article>`;
}

function renderHomeSearchResults(query, { facts = [], chunks = [] } = {}) {
  const total = facts.length + chunks.length;
  if (!total) {
    homeSearchSetResults(`<div class="home-search-empty"><strong>No matching memory yet</strong><span>Try a more specific question, or save the decision with <code>sigil remember "…"</code>.</span></div>`, 'empty');
    return;
  }

  const factRows = facts.length
    ? `<section class="home-search-group"><h4>Saved memories <span>${facts.length}</span></h4>${facts.map((fact) => homeSearchResultRow(fact, 'fact')).join('')}</section>`
    : '';
  const sourceRows = chunks.length
    ? `<section class="home-search-group"><h4>Notes and files <span>${chunks.length}</span></h4>${chunks.map((chunk) => homeSearchResultRow(chunk, 'source')).join('')}</section>`
    : '';
  homeSearchSetResults(`<div class="home-search-result-head"><span>Best matches for <strong>“${escape(query)}”</strong></span><span>${total} result${total === 1 ? '' : 's'}</span></div><div class="home-search-groups">${factRows}${sourceRows}</div>`);
}

async function runHomeSearch(query) {
  const submit = $('#home-search-submit');
  const clear = $('#home-search-clear');
  const requestId = ++homeSearch.requestId;
  homeSearch.busy = true;
  if (submit) { submit.disabled = true; submit.textContent = 'Searching…'; }
  if (clear) clear.hidden = true;
  homeSearchSetResults('<div class="home-search-loading"><span class="loading-dot" aria-hidden="true"></span>Searching local memory…</div>', 'loading');

  try {
    const result = await rpc('search', {
      query,
      limit: 8,
      includeChunks: true,
      applyFloor: false,
    });
    if (requestId !== homeSearch.requestId) return;
    renderHomeSearchResults(query, result);
  } catch (err) {
    if (requestId !== homeSearch.requestId) return;
    const message = escape(err.message || 'Search failed.');
    homeSearchSetResults(`<div class="home-search-empty error"><strong>Memory search could not run</strong><span>${message} Check that Memory search is ready in <a href="#settings" data-route="settings">Settings</a>, then try again.</span></div>`, 'error');
  } finally {
    if (requestId === homeSearch.requestId) {
      homeSearch.busy = false;
      if (submit) { submit.disabled = false; submit.textContent = 'Search'; }
      if (clear) clear.hidden = $('#home-search-results')?.hidden || false;
    }
  }
}

$('#home-search-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (homeSearch.busy) return;
  const query = $('#home-search-query')?.value.trim();
  if (query) runHomeSearch(query);
});
$('#home-search-clear')?.addEventListener('click', () => {
  homeSearch.requestId++;
  homeSearch.busy = false;
  const query = $('#home-search-query');
  if (query) { query.value = ''; query.focus(); }
  homeSearchSetResults();
});

// ════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE — facts and source provenance
// ════════════════════════════════════════════════════════════════════
const kb = {
  tab: 'facts',
  loaded: false,
  facts: [],          // full fetched set (cross-namespace)
  factNs: null,       // active namespace filter (null = all)
  factCat: null,      // active category filter (null = all)
  factSearch: '',
  selectedFactUid: null,
};

// Confidence carries the only semantic color; importance/category stay neutral
// to keep the surface restrained (brand rule: accent for state, not decoration).
function confidenceClass(c) {
  if (c === 'high') return 'ok';
  if (c === 'low') return 'warn';
  return 'info'; // medium / unknown
}
function titleCase(s) {
  return String(s || '').replace(/_/g, ' ');
}

async function refreshKb() {
  kbLoadStats();
  if (!kb.loaded) await kbLoadFacts();
  kb.loaded = true;
  kbRenderFacts();
}

async function kbLoadStats() {
  const strip = $('#kb-stats');
  try {
    const d = await rpc('status', {});
    const stats = [
      ['Facts', d.facts], ['Source documents', d.documents],
    ];
    // Passages only exist after a document is ingested. Showing a persistent
    // zero to someone using ordinary memory writes creates a false expectation
    // that every fact should have a document chunk behind it.
    if (d.documents > 0) stats.push(['Source passages', d.chunks]);
    strip.innerHTML = stats.map(([k, v]) =>
      `<div class="kb-stat"><span class="kb-stat-v">${escape(v)}</span><span class="kb-stat-k">${escape(k)}</span></div>`).join('');
  } catch (err) {
    strip.innerHTML = `<div class="kb-stat-err">Couldn’t load totals: ${escape(err.message)}</div>`;
  }
}

// ── Facts ────────────────────────────────────────────────────────────
async function kbLoadFacts() {
  const list = $('#kb-fact-list');
  list.innerHTML = kbSkeleton(7);
  try {
    const { facts } = await rpc('listFacts', { limit: 200 });
    kb.facts = facts || [];
    kbRenderFactFilters();
    kbRenderFacts();
  } catch (err) {
    list.innerHTML = `<div class="empty">Couldn’t load facts: ${escape(err.message)}</div>`;
  }
}

function kbRenderFactFilters() {
  const namespaces = [...new Set(kb.facts.map((f) => f.namespace).filter(Boolean))].sort();
  const categories = [...new Set(kb.facts.map((f) => f.category).filter(Boolean))].sort();
  const chip = (label, active, val, group) =>
    `<button class="chip${active ? ' active' : ''}" data-kbfilter="${group}" data-val="${val === null ? '' : escape(val)}" type="button">${escape(label)}</button>`;
  $('#kb-fact-ns').innerHTML = namespaces.length > 1
    ? [chip('All namespaces', kb.factNs === null, null, 'ns'),
       ...namespaces.map((n) => chip(n, kb.factNs === n, n, 'ns'))].join('')
    : '';
  $('#kb-fact-cat').innerHTML = categories.length
    ? [chip('All categories', kb.factCat === null, null, 'cat'),
       ...categories.map((c) => chip(titleCase(c), kb.factCat === c, c, 'cat'))].join('')
    : '';
}

function kbFilteredFacts() {
  const q = kb.factSearch.trim().toLowerCase();
  return kb.facts.filter((f) => {
    if (kb.factNs && f.namespace !== kb.factNs) return false;
    if (kb.factCat && f.category !== kb.factCat) return false;
    if (q && !(f.content || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function kbRenderFacts() {
  const list = $('#kb-fact-list');
  const facts = kbFilteredFacts();
  $('#kb-fact-count').textContent = `${facts.length} fact${facts.length === 1 ? '' : 's'}`;
  if (!facts.length) {
    list.innerHTML = kb.facts.length
      ? `<div class="empty">No facts match this filter. Clear the search or pick a different category.</div>`
      : `<div class="empty">No facts stored yet. Sigil fills this as your agents work — or run <code>sigil remember "…"</code>.</div>`;
    return;
  }
  list.innerHTML = facts.map((f) => {
    const sel = f.uid === kb.selectedFactUid ? ' selected' : '';
    const cat = f.category ? `<span class="kb-tag">${escape(titleCase(f.category))}</span>` : '';
    const conf = f.confidence ? `<span class="kb-dot ${confidenceClass(f.confidence)}" title="confidence: ${escape(f.confidence)}"></span>` : '';
    return `<button class="kb-row${sel}" role="option" aria-selected="${sel ? 'true' : 'false'}" data-uid="${escape(f.uid)}" type="button">
      <span class="kb-row-main">${conf}<span class="kb-row-text">${escape(f.content)}</span></span>
      <span class="kb-row-meta">${cat}</span>
    </button>`;
  }).join('');
}

async function kbSelectFact(uid) {
  kb.selectedFactUid = uid;
  $$('#kb-fact-list .kb-row').forEach((r) => {
    const on = r.dataset.uid === uid;
    r.classList.toggle('selected', on);
    r.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const pane = $('#kb-fact-detail');
  pane.classList.add('open');
  pane.innerHTML = `<div class="kb-detail-pad">${kbSkeleton(4)}</div>`;
  try {
    const ctx = await rpc('getFactContext', { uid });
    if (ctx.notFound) { pane.innerHTML = `<div class="kb-detail-pad"><div class="empty">Fact not found.</div></div>`; return; }
    pane.innerHTML = kbRenderFactDetail(ctx);
  } catch (err) {
    pane.innerHTML = `<div class="kb-detail-pad"><div class="empty">Couldn’t load detail: ${escape(err.message)}</div></div>`;
  }
}

function kbRenderFactDetail(ctx) {
  const f = ctx.fact;
  const badges = [];
  if (f.confidence) badges.push(`<span class="badge ${confidenceClass(f.confidence)}">${escape(f.confidence)} confidence</span>`);
  if (f.category) badges.push(`<span class="badge">${escape(titleCase(f.category))}</span>`);
  if (f.status) badges.push(`<span class="badge ${f.status === 'active' ? 'ok' : 'warn'}">${escape(f.status)}</span>`);

  const meta = [];
  if (f.agent) meta.push(['written by', f.agent]);
  if (f.namespace) meta.push(['memory scope', f.namespace]);
  if (f.sourceSection) meta.push(['source section', f.sourceSection]);
  if (f.uid) meta.push(['uid', f.uid]);
  const metaBlock = meta.length
    ? `<div class="kb-block"><div class="trace-block-h">Provenance</div><div class="kv kb-kv">${meta.map(([k, v]) =>
        `<div class="row"><div class="k">${escape(k)}</div><div class="v">${escape(v)}</div></div>`).join('')}</div></div>`
    : '';

  const docs = (ctx.documents || []).length
    ? `<div class="kb-block"><div class="trace-block-h">Source documents</div>${ctx.documents.map((d) =>
        `<div class="kb-link-row"><span class="kb-link-name">${escape(d.title || `document #${d.id}`)}</span><span class="kb-tag">${escape(d.sourceType || 'doc')}</span></div>`).join('')}</div>`
    : '';

  return `<div class="kb-detail-pad">
    <div class="kb-detail-head">
      <div class="kb-badges">${badges.join('')}</div>
      <button class="btn ghost small kb-forget" data-uid="${escape(f.uid)}" type="button" title="Forget this fact">Forget</button>
    </div>
    <p class="kb-fact-body">${escape(f.content)}</p>
    ${metaBlock}${docs}
  </div>`;
}

async function kbForgetFact(uid) {
  if (!window.confirm('Forget this fact? It will be removed from memory and stop being recalled.')) return;
  try {
    await rpc('forgetFact', { uid });
    toast({ variant: 'success', message: 'Fact forgotten.' });
    kb.facts = kb.facts.filter((f) => f.uid !== uid);
    kb.selectedFactUid = null;
    $('#kb-fact-detail').classList.remove('open');
    $('#kb-fact-detail').innerHTML = '';
    kbRenderFactFilters();
    kbRenderFacts();
    kbLoadStats();
  } catch (err) {
    toast({ variant: 'error', message: `Couldn’t forget fact: ${err.message}` });
  }
}

// ── KB event wiring (delegated) ──────────────────────────────────────
function kbSkeleton(n) {
  return `<div class="kb-skel-wrap">${Array.from({ length: n }, () => '<div class="kb-skel"></div>').join('')}</div>`;
}

$('#kb-refresh')?.addEventListener('click', refreshKb);
$('#kb-fact-search')?.addEventListener('input', (e) => { kb.factSearch = e.target.value; kbRenderFacts(); });
$('#kb-fact-ns')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kbfilter="ns"]'); if (!b) return;
  kb.factNs = b.dataset.val || null; kbRenderFactFilters(); kbRenderFacts();
});
$('#kb-fact-cat')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kbfilter="cat"]'); if (!b) return;
  kb.factCat = b.dataset.val || null; kbRenderFactFilters(); kbRenderFacts();
});
$('#kb-fact-list')?.addEventListener('click', (e) => {
  const row = e.target.closest('.kb-row'); if (row) kbSelectFact(row.dataset.uid);
});
$('#kb-fact-detail')?.addEventListener('click', (e) => {
  const forget = e.target.closest('.kb-forget'); if (forget) kbForgetFact(forget.dataset.uid);
});


const runtime = { busy: false, status: null };

function setRuntimeResult(message = '', variant = '') {
  const node = $('#runtime-result');
  if (!node) return;
  node.hidden = !message;
  node.className = `result${variant ? ` ${variant}` : ''}`;
  node.textContent = message;
}

function runtimeBadge(kind, label) {
  const node = $('#runtime-state');
  if (!node) return;
  node.className = `badge ${kind}`;
  node.textContent = label;
}

function renderRuntime(status) {
  runtime.status = status;
  const card = $('#runtime-card');
  const summary = $('#runtime-summary');
  const detail = $('#runtime-detail');
  const actions = $('#runtime-actions');
  if (!card || !summary || !detail || !actions) return;
  card.setAttribute('aria-busy', 'false');

  const supervisor = status?.supervisor || {};
  if (supervisor.unsupported) {
    runtimeBadge('info', 'on demand');
    summary.textContent = 'This platform starts Sigil when a local tool needs memory.';
    detail.textContent = 'An always-on background service is not available here. Storage and retrieval still stay local.';
    actions.innerHTML = '<button type="button" class="btn" data-runtime-action="refresh">Check again</button>';
    return;
  }

  if (supervisor.installed && supervisor.running) {
    runtimeBadge('ok', 'automatic start on');
    summary.textContent = `Sigil starts at login and restarts if it stops (${supervisor.manager}).`;
    detail.textContent = 'The memory engine is managed locally. Restart it only if diagnostics say it is unresponsive.';
    actions.innerHTML = `
      <button type="button" class="btn" data-runtime-action="refresh">Check now</button>
      <button type="button" class="btn" data-runtime-action="restart">Restart memory engine</button>
      <button type="button" class="btn danger" data-runtime-action="confirm-uninstall">Disable automatic start</button>`;
    return;
  }

  if (supervisor.installed) {
    runtimeBadge('warn', 'needs attention');
    summary.textContent = `Automatic start is installed, but ${supervisor.manager} is not running Sigil.`;
    detail.textContent = 'Restart the managed service. Your stored memories are not changed.';
    actions.innerHTML = `
      <button type="button" class="btn" data-runtime-action="refresh">Check now</button>
      <button type="button" class="btn primary" data-runtime-action="restart">Restart memory engine</button>
      <button type="button" class="btn danger" data-runtime-action="confirm-uninstall">Disable automatic start</button>`;
    return;
  }

  runtimeBadge('warn', 'manual start');
  summary.textContent = 'Sigil runs when a local tool calls it, but it is not set to start automatically.';
  detail.textContent = 'Enable automatic start to keep memory available after login, sleep, or a crash.';
  actions.innerHTML = `
    <button type="button" class="btn" data-runtime-action="refresh">Check now</button>
    <button type="button" class="btn primary" data-runtime-action="install">Enable automatic start</button>`;
}

async function refreshRuntime({ quiet = false } = {}) {
  const card = $('#runtime-card');
  if (!card || runtime.busy) return;
  if (!quiet) card.setAttribute('aria-busy', 'true');
  try {
    renderRuntime(await rpc('serviceStatus'));
  } catch (err) {
    card.setAttribute('aria-busy', 'false');
    runtimeBadge('danger', 'unavailable');
    $('#runtime-summary').textContent = 'Sigil could not check the local runtime.';
    $('#runtime-detail').textContent = 'Check that the daemon is running, then try again.';
    $('#runtime-actions').innerHTML = '<button type="button" class="btn primary" data-runtime-action="refresh">Try again</button>';
    setRuntimeResult(err.message, 'err');
  }
}

function confirmRuntimeUninstall() {
  const host = $('#runtime-confirm');
  if (!host) return;
  host.innerHTML = `
    <div class="result warn">
      <strong>Disable automatic start?</strong>
      <span>Sigil will still start when a local tool requests memory.</span>
      <div class="settings-actions">
        <button type="button" class="btn danger" data-runtime-confirm="uninstall">Disable automatic start</button>
        <button type="button" class="btn" data-runtime-cancel>Cancel</button>
      </div>
    </div>`;
  host.querySelector('[data-runtime-cancel]').addEventListener('click', () => { host.innerHTML = ''; });
  host.querySelector('[data-runtime-confirm]').addEventListener('click', () => runRuntimeAction('uninstall'));
}

async function runRuntimeAction(action) {
  if (runtime.busy) return;
  if (action === 'confirm-uninstall') return confirmRuntimeUninstall();
  if (action === 'refresh') return refreshRuntime();

  runtime.busy = true;
  const card = $('#runtime-card');
  card?.setAttribute('aria-busy', 'true');
  $$('#runtime-actions button, #runtime-confirm button').forEach((button) => { button.disabled = true; });
  const words = { install: 'Enabling automatic start…', restart: 'Restarting memory engine…', uninstall: 'Disabling automatic start…' };
  setRuntimeResult(words[action] || 'Working…');
  try {
    if (action === 'install') {
      await rpc('serviceInstall');
      setRuntimeResult('Automatic start enabled. Waiting for the local GUI to come back…', 'ok');
      waitForGuiRecovery();
      return;
    }
    if (action === 'restart') {
      await rpc('serviceRestart');
      setRuntimeResult('Restart requested. Checking the local service again…', 'ok');
      setTimeout(() => refreshRuntime(), 900);
      return;
    }
    if (action === 'uninstall') {
      await rpc('serviceUninstall');
      $('#runtime-confirm').innerHTML = '';
      setRuntimeResult('Automatic start disabled. Sigil will still start when a local tool needs it.', 'ok');
    }
  } catch (err) {
    setRuntimeResult(err.message, 'err');
  } finally {
    runtime.busy = false;
    card?.setAttribute('aria-busy', 'false');
    if (action !== 'install' && action !== 'restart') refreshRuntime({ quiet: true });
  }
}

async function waitForGuiRecovery({ attempts = 60, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const response = await fetch('/healthz', { cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch { /* the old daemon is still handing off the loopback port */ }
  }
  setRuntimeResult('Automatic start is enabled, but the GUI did not return in 30 seconds. Run `sigil daemon open` to reopen it.', 'warn');
}

$('#runtime-actions')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-runtime-action]');
  if (button) runRuntimeAction(button.dataset.runtimeAction);
});

async function refreshEnv() {
  // Config summary from the config store (config.json), secrets masked.
  try {
    const c = await rpc('setup.config', {});
    const db = c.database || {};
    const dbDesc = db.mode === 'url' ? `connection URL (${db.urlHost || '—'})`
      : db.mode === 'docker' ? `Docker container (localhost:${db.port})`
      : db.mode === 'local' ? `local Postgres (${db.host}:${db.port})`
      : db.mode === 'embedded' ? 'built-in (embedded)'
      : 'not configured';
    $('#cfg-db').textContent = `${dbDesc}${c.setup?.steps?.database === 'done' ? ' · ready' : ''}`;
    const dbReady = c.setup?.steps?.database === 'done';
    $('#cfg-db-state').className = `badge ${dbReady ? 'ok' : 'warn'}`;
    $('#cfg-db-state').textContent = dbReady ? 'ready' : 'needs setup';
    $('#cfg-llm').textContent = c.llm?.provider ? `${c.llm.provider}${c.llm.model ? ` · ${c.llm.model}` : ''}` : 'not configured';
    $('#cfg-disable-llm').hidden = !c.llm?.provider;
    $('#cfg-llm-state').className = `badge ${c.llm?.provider ? 'info' : ''}`;
    $('#cfg-llm-state').textContent = c.llm?.provider ? 'enabled' : 'off';
    $('#cfg-emb').textContent = c.embedding?.provider
      ? `${c.embedding.provider} · ${c.embedding.model} · ${c.embedding.dim}d`
      : 'not configured';
    const embReady = Boolean(c.embedding?.provider);
    $('#cfg-emb-state').className = `badge ${embReady ? 'ok' : 'warn'}`;
    $('#cfg-emb-state').textContent = embReady ? 'ready' : 'needs setup';
    const tbody = $('#env-table tbody');
    if (tbody) {
      const rows = [
        ['Database', dbDesc],
        ['LLM provider', c.llm?.provider || '—'],
        ['LLM model', c.llm?.model || '—'],
        ['LLM key', c.llm?.hasKey ? 'configured' : '—'],
        ['Embedding provider', c.embedding?.provider || '—'],
        ['Embedding model', c.embedding?.model || '—'],
        ['Embedding dim', String(c.embedding?.dim || '—')],
        ['Embedding key', c.embedding?.hasKey ? 'configured' : '—'],
      ];
      tbody.innerHTML = rows.map(([k, v]) => `<tr><td class="mono">${escape(k)}</td><td>${escape(v)}</td></tr>`).join('');
    }
  } catch (err) {
    const tbody = $('#env-table tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="2" class="empty">${escape(err.message)}</td></tr>`;
  }
}

// ── Settings: coding agents ──────────────────────────────────────────
// Same flow as the onboarding CONNECTORS step, surfaced post-onboarding so
// users who skipped the step (or completed setup before this card existed)
// can still wire up Claude Code / Cursor / Codex / Kiro / Hermes.
// ════════════════════════════════════════════════════════════════════
// AGENTS — connect coding tools to this memory + per-agent activity
// ════════════════════════════════════════════════════════════════════
async function refreshAgents() {
  const host = $('#agents-connectors');
  let connectors = [];
  if (host) {
    try {
      ({ connectors } = await rpc('listConnectors'));
      host.innerHTML = '';
      if (!connectors.length) host.innerHTML = '<div class="muted">no coding tools detected on this machine</div>';
      else connectors.forEach((c) => host.appendChild(connectorCard(c, onAgentAction)));
    } catch (err) {
      host.innerHTML = `<div class="muted">could not load agents: ${escape(err.message)}</div>`;
    }
  }
  loadAgentActivity();
  loadRecallActivity(connectors);
}

async function onAgentAction(id, action) {
  const host = $('#agents-connectors');
  const card = host?.querySelector(`[data-id="${id}"]`);
  if (action === 'disconnect') {
    try {
      await rpc('disconnectConnector', { id });
      toast({ variant: 'success', message: `${id} disconnected` });
    } catch (err) { toast({ variant: 'error', message: err.message, hint: err.hint, code: err.code }); }
    return refreshAgents();
  }
  if (card) card.replaceWith(connectorCard({ id, label: id, hint: '', uiState: 'connecting' }, onAgentAction));
  try {
    await rpc('connectConnector', { id });
    toast({ variant: 'success', message: `${id} connected` });
  } catch (err) {
    toast({ variant: 'error', message: err.message || `could not connect ${id}`, hint: err.hint, code: err.code });
  }
  return refreshAgents();
}

// Per-agent successful saved-memory operations from the bounded durable trace.
async function loadAgentActivity() {
  const tbody = $('#agents-activity tbody');
  if (!tbody) return;
  let traces;
  try { ({ traces } = await rpc('trace.list', { limit: 200 })); }
  catch (err) { tbody.innerHTML = `<tr><td colspan="3" class="empty">could not load activity: ${escape(err.message)}</td></tr>`; return; }

  const byAgent = new Map();
  for (const t of traces) {
    if (!t.agent) continue;
    if (!isSuccessfulSave(t)) continue;
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, { saves: 0, last: t.ts }); // first seen = latest
    const rec = byAgent.get(t.agent);
    rec.saves++;
  }
  const rows = [...byAgent.entries()].sort((a, b) => b[1].saves - a[1].saves);
  tbody.innerHTML = rows.length
    ? rows.map(([agent, r]) => `<tr>
        <td><span class="badge ${agentBadge(agent)}">${escape(agent)}</span></td>
        <td class="num">${r.saves}</td>
        <td class="num">${escape(clock(r.last))}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="empty">no successful saved-memory operations yet</td></tr>';
}

function isSuccessfulSave(t) {
  const detail = t.detail || {};
  if (t.kind === 'remember') return Number(detail.totals?.added || 0) > 0;
  // Older Sigil builds called direct remembers `ingest`; preserve their
  // semantics when displaying the bounded historic log.
  if (t.kind === 'ingest' && detail.op === 'remember') return Number(detail.totals?.added || 0) > 0;
  if (t.kind === 'ingest') return detail.skipped !== true;
  return t.kind === 'correct' && detail.op === 'correctFact';
}

function agentForConnector(connector) {
  return connector.id === 'codex-cli' ? 'codex' : connector.id;
}

// Automatic recall observations live only in the daemon. That gives users
// evidence that the hot path ran without turning every prompt into a PGlite
// write. A daemon restart intentionally starts a fresh observation window.
async function loadRecallActivity(connectors = []) {
  const tbody = $('#agents-recall tbody');
  if (!tbody) return;
  const automatic = connectors.filter((c) => c.installed && c.automaticRecall);
  if (!automatic.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">no connected agent supports automatic recall</td></tr>';
    return;
  }

  let status;
  try { status = await rpc('recall.status', { limit: 100 }); }
  catch (err) { tbody.innerHTML = `<tr><td colspan="4" class="empty">could not load recall status: ${escape(err.message)}</td></tr>`; return; }

  const byAgent = new Map((status.agents || []).map((entry) => [entry.agent, entry]));
  tbody.innerHTML = automatic.map((connector) => {
    const agent = agentForConnector(connector);
    const entry = byAgent.get(agent);
    const attentionLabel = connector.attentionKind === 'approval'
      ? 'approval required'
      : connector.attentionKind === 'outdated'
        ? 'refresh needed'
        : 'needs attention';
    const readiness = connector.attention
      ? `<span class="badge warn" title="${escape(connector.attention)}">${attentionLabel}</span>`
      : '<span class="badge ok">ready</span>';
    const last = entry?.last
      ? escape(clock(entry.last.ts))
      : '<span class="muted">no prompt since daemon start</span>';
    let result = '<span class="muted">waiting for a prompt</span>';
    if (entry?.last) {
      result = entry.last.outcome === 'matched'
        ? `<span class="badge ok">${entry.last.resultCount} matched</span> <span class="muted">${entry.last.durationMs}ms</span>`
        : `<span class="muted">no relevant memories · ${entry.last.durationMs}ms</span>`;
    }
    return `<tr>
      <td><span class="badge ${agentBadge(agent)}">${escape(connector.label)}</span></td>
      <td>${readiness}</td><td class="num">${last}</td><td>${result}</td>
    </tr>`;
  }).join('');
}

// ── Settings: live provider switcher (LLM + embedding) ───────────────
// Drives the same setup service the first-run wizard uses (setup.detect +
// setup.run). "Apply" persists config + live-tests, then restarts the daemon
// so the new provider takes effect; the 5s health poll recovers from the gap.
const cfgSwitch = { kind: null, step: null, providerId: null, providers: [] };

async function openSwitcher(kind) {
  cfgSwitch.kind = kind;
  cfgSwitch.step = kind === 'llm' ? 'llm' : 'embedding';
  cfgSwitch.providerId = null;
  $('#cfg-switch-title').textContent = kind === 'llm' ? 'Change LLM provider' : 'Change embedding provider';
  $('#cfg-switch-conflict').innerHTML = '';
  $('#cfg-switch-fields').innerHTML = '';
  const res = $('#cfg-switch-result'); res.style.display = 'none'; res.textContent = '';
  $('#cfg-switch').style.display = '';
  try {
    const { providers } = await rpc('setup.detect', { step: cfgSwitch.step });
    cfgSwitch.providers = providers || [];
    $('#cfg-switch-cards').innerHTML = cfgSwitch.providers.map((p) => `
      <label class="provider-card" data-cfg-id="${escape(p.id)}">
        <span class="check"></span>
        <span class="name">${escape(p.label)}${p.recommended ? ' <span class="badge info" style="margin-left:var(--s-2);">RECOMMENDED</span>' : ''}</span>
        <span class="hint">${escape(p.hint)}</span>
      </label>`).join('');
  } catch (err) {
    $('#cfg-switch-cards').innerHTML = `<div class="muted">failed: ${escape(err.message)}</div>`;
  }
}

// Fields to collect for the chosen provider (llm: from the catalog; embedding:
// synthesized — a key unless it can reuse the LLM key, + an Ollama host).
function cfgSwitchFields(p) {
  if (cfgSwitch.step === 'llm') return p.fields || [];
  const f = [];
  if (p.keyed && !p.sharedKeyAvailable) f.push({ name: 'apiKey', label: `${p.label} API key`, type: 'password', placeholder: 'paste key' });
  if (p.id === 'ollama') f.push({ name: 'host', label: 'Ollama host', type: 'text', placeholder: 'http://localhost:11434', optional: true });
  return f;
}

function selectSwitchProvider(id) {
  cfgSwitch.providerId = id;
  $$('#cfg-switch-cards .provider-card').forEach((c) => c.classList.toggle('selected', c.dataset.cfgId === id));
  const p = cfgSwitch.providers.find((x) => x.id === id);
  if (!p) return;
  const fields = cfgSwitchFields(p);
  $('#cfg-switch-fields').innerHTML = fields.length
    ? fields.map((f) => `<label class="field"><span class="label">${escape(f.label)}</span>
        <input type="${escape(f.type)}" data-cfg-field="${escape(f.name)}" placeholder="${escape(f.placeholder || '')}" autocomplete="off"></label>`).join('')
    : '<p class="muted text-sm">No additional configuration needed.</p>';
  $('#cfg-switch-conflict').innerHTML = '';
}

$('#cfg-change-llm')?.addEventListener('click', () => openSwitcher('llm'));
$('#cfg-change-emb')?.addEventListener('click', () => openSwitcher('embedding'));
$('#cfg-switch-cancel')?.addEventListener('click', () => { $('#cfg-switch').style.display = 'none'; });
$('#cfg-switch-cards')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-cfg-id]');
  if (card) selectSwitchProvider(card.dataset.cfgId);
});

$('#cfg-switch-apply')?.addEventListener('click', async () => {
  if (!cfgSwitch.providerId) return;
  const input = { provider: cfgSwitch.providerId };
  $$('#cfg-switch-fields [data-cfg-field]').forEach((i) => { if (i.value) input[i.dataset.cfgField] = i.value; });
  const out = $('#cfg-switch-result');
  out.style.display = 'block'; out.className = 'result'; out.textContent = 'saving…';
  try {
    const res = await rpc('setup.run', { step: cfgSwitch.step, input });
    if (!res.ok) {
      out.classList.add('err');
      const msg = res.error || (res.errors && Object.values(res.errors)[0]) || 'failed';
      out.textContent = `✗ ${msg}${res.hint ? `\n  → ${res.hint}` : ''}`;
      return;
    }
    out.classList.add('ok');
    out.textContent = cfgSwitch.step === 'llm'
      ? `✓ LLM responded: "${res.result?.response || 'ok'}"`
      : `✓ embedder healthy — ${res.result?.dim}-dim`;
    refreshEnv();
    refreshHealth();
  } catch (err) {
    out.classList.add('err'); out.textContent = `✗ ${err.message}`;
  }
});

$('#cfg-disable-llm')?.addEventListener('click', () => {
  const host = $('#cfg-llm-confirm');
  if (!host) return;
  host.innerHTML = `
    <div class="result warn">
      <strong>Turn off the optional LLM?</strong>
      <span>Its saved provider details and API key will be removed. Memory storage and search keep working.</span>
      <div class="settings-actions">
        <button type="button" class="btn danger" data-disable-llm>Turn off LLM</button>
        <button type="button" class="btn" data-cancel-disable>Cancel</button>
      </div>
    </div>`;
  host.querySelector('[data-cancel-disable]').addEventListener('click', () => { host.innerHTML = ''; });
  host.querySelector('[data-disable-llm]').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Turning off…';
    try {
      await rpc('setup.disableLlm', { confirm: true });
      host.innerHTML = '';
      toast({ variant: 'success', message: 'Optional LLM turned off. Storage and search are unchanged.' });
      refreshEnv();
    } catch (err) {
      host.innerHTML = `<div class="result err">✗ ${escape(err.message)}</div>`;
    }
  });
});

// ── Settings: danger zone — factory reset ────────────────────────────
$('#reset-understand')?.addEventListener('change', (event) => {
  $('#cfg-reset').disabled = !event.target.checked;
});

$('#cfg-reset')?.addEventListener('click', () => {
  const host = $('#reset-confirm');
  if (!host) return;
  const wipeMemory = $('#reset-wipe-memory')?.checked !== false;
  host.innerHTML = `
    <div class="result err" style="margin:0;">
      <strong>Reset Sigil?</strong>
      <div class="muted" style="margin:6px 0;">Disconnects every agent${wipeMemory ? ', wipes all stored memory,' : ''} and clears your config. You'll go back to setup. (The database itself is kept — use <code>sigil reset</code> in a terminal for a full DB teardown.)</div>
      <div class="flex-row" style="margin-top:8px;">
        <button type="button" class="btn danger" data-reset-go>Yes, reset</button>
        <button type="button" class="btn" data-reset-cancel>Cancel</button>
      </div>
    </div>`;
  host.querySelector('[data-reset-cancel]').addEventListener('click', () => { host.innerHTML = ''; });
  host.querySelector('[data-reset-go]').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Resetting…';
    try {
      const r = await rpc('setup.factoryReset', { wipeMemory, confirm: true });
      toast({ variant: 'success', message: `Reset complete — disconnected ${r.disconnected?.length || 0} agent(s)${wipeMemory ? `, wiped ${r.tablesWiped || 0} tables` : ''}.` });
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      host.innerHTML = `<div class="result err" style="margin:0;">✗ ${escape(err.message)}</div>`;
    }
  });
});

// ── Activity / causal trace log ──────────────────────────────────────
let ws = null;
let traceFilter = '';
let traceAgentFilter = '';
const seenTraceUids = new Set();

function ensureActivityWs() {
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/v1/events`);
  ws.addEventListener('open',  () => setActivityStatus('ok', 'live'));
  ws.addEventListener('close', () => {
    setActivityStatus('err', 'disconnected');
    setTimeout(() => { if (location.hash === '#activity') ensureActivityWs(); }, 1500);
  });
  ws.addEventListener('error', () => setActivityStatus('err', 'error'));
  ws.addEventListener('message', (e) => { try { onLiveEvent(JSON.parse(e.data)); } catch {} });
}
function setActivityStatus(state, label) { const el = $('#activity-status'); if (!el) return; el.className = `conn-status ${state}`; el.textContent = label; }

function onLiveEvent(evt) {
  if (evt.type === 'trace') {
    if (traceFilter && evt.kind !== traceFilter) return;
    if (traceAgentFilter && evt.agent !== traceAgentFilter) return;
    prependTrace(evt, true);
  } else if (!traceFilter && !traceAgentFilter) {
    // Operational daemon events are shown only in the unfiltered view.
    prependOpEvent(evt);
  }
}

async function loadTraces() {
  const list = $('#trace-list');
  if (!list) return;
  try {
    const { traces } = await rpc('trace.list', { kind: traceFilter || undefined, agent: traceAgentFilter || undefined, limit: 50 });
    seenTraceUids.clear();
    list.innerHTML = '';
    if (!traces.length) { $('#activity-empty').style.display = 'block'; return; }
    $('#activity-empty').style.display = 'none';
    for (const t of traces) { list.appendChild(traceCard(t)); seenTraceUids.add(t.uid); }
  } catch (err) {
    list.innerHTML = `<li class="empty">failed to load history: ${escape(err.message)}</li>`;
  }
}

function prependTrace(t, isLive) {
  if (t.uid && seenTraceUids.has(t.uid)) return;
  if (t.uid) seenTraceUids.add(t.uid);
  $('#activity-empty').style.display = 'none';
  const card = traceCard(t);
  if (isLive) card.classList.add('flash');
  $('#trace-list').prepend(card);
  trimList();
}
function prependOpEvent(evt) {
  $('#activity-empty').style.display = 'none';
  const li = document.createElement('li');
  li.className = 'trace-card op';
  const ts = clock(evt.ts);
  li.innerHTML = `<div class="trace-head static">
    <span class="trace-ts">${escape(ts)}</span>
    <span class="badge ${opBadge(evt.type)}">${escape(evt.type)}</span>
    <span class="trace-summary">${opSummary(evt)}</span></div>`;
  $('#trace-list').prepend(li);
  trimList();
}
function trimList() { const ul = $('#trace-list'); while (ul.childNodes.length > 200) ul.removeChild(ul.lastChild); }

function traceCard(t) {
  const li = document.createElement('li');
  li.className = 'trace-card';
  const dur = t.durationMs != null ? `${t.durationMs}ms` : '';
  const ns = t.namespace ? `<span class="trace-ns">${escape(t.namespace)}</span>` : '';
  const agent = t.agent ? `<span class="badge ${agentBadge(t.agent)}" title="originating agent">${escape(t.agent)}</span>` : '';
  li.innerHTML = `
    <button class="trace-head" type="button" aria-expanded="false">
      <span class="trace-caret">▸</span>
      <span class="trace-ts">${escape(clock(t.ts))}</span>
      <span class="badge ${traceBadge(t.kind)}">${escape(t.kind)}</span>
      ${agent}
      <span class="trace-summary">${escape(t.summary)}</span>
      ${ns}
      <span class="trace-dur">${escape(dur)}</span>
    </button>
    <div class="trace-detail" hidden></div>`;
  const head = li.querySelector('.trace-head');
  const body = li.querySelector('.trace-detail');
  head.addEventListener('click', () => {
    const isOpen = !body.hasAttribute('hidden');
    if (isOpen) { body.setAttribute('hidden', ''); head.setAttribute('aria-expanded', 'false'); li.classList.remove('open'); return; }
    if (!body.dataset.rendered) { body.innerHTML = renderTraceDetail(t); body.dataset.rendered = '1'; }
    body.removeAttribute('hidden'); head.setAttribute('aria-expanded', 'true'); li.classList.add('open');
  });
  return li;
}

// ── Detail renderers ─────────────────────────────────────────────────
function renderTraceDetail(t) {
  const d = t.detail || {};
  const source = renderSourceBlock(t, d);
  if (t.kind === 'ingest' || t.kind === 'remember') return source + renderIngestTrace(d);
  return source + `<pre class="trace-json">${escape(JSON.stringify(d, null, 2))}</pre>`;
}

// Who made this write.
function renderSourceBlock(t, d) {
  const rows = [
    ['agent', t.agent],
    ['transport', t.transport],
    ['cwd', d.cwd],
  ].filter(([, v]) => v != null && v !== '');
  if (!rows.length) return '';
  return traceBlock('Source', rows.map(([k, v]) => kvline(k, v)).join(' '));
}

const sc = (v) => (v === null || v === undefined ? '—' : String(v));

function renderIngestTrace(d) {
  const parts = [];
  const inputs = d.inputs || (d.verdicts ? [{ input: d.title, route: d.route, counts: d.counts, verdicts: d.verdicts }] : []);

  if (d.totals) parts.push(traceBlock('Totals', `${kvline('added', d.totals.added)} ${kvline('alreadyKnown', d.totals.alreadyKnown)} ${kvline('inputs', d.totals.inputCount)}`));

  inputs.forEach((inp, i) => {
    const verdictRows = (inp.verdicts || []).map((v) => {
      const a = v.dedup || {};
      const simTxt = a.topSimilarity != null
        ? `sim <strong>${a.topSimilarity.toFixed(3)}</strong> ${dedupExplain(a)}`
        : `<span class="muted">${escape(a.decision || 'no match — new fact')}</span>`;
      return `<tr>
        <td><span class="badge ${dedupBadge(v.action)}">${escape(v.action)}</span></td>
        <td class="fact-cell">${escape(v.content)}</td>
        <td>${simTxt}</td>
      </tr>`;
    }).join('');

    const head = `${inp.route ? `<span class="badge info">route: ${escape(inp.route)}</span> ` : ''}${inp.skipped ? '<span class="badge warn">skipped</span> ' : ''}<span class="muted">${escape(String(inp.input || '').slice(0, 160))}</span>`;
    const counts = inp.counts ? `<div class="muted text-xs" style="margin:6px 0">+${inp.counts.added} added · ${inp.counts.skipped} already known</div>` : '';

    parts.push(`<div class="trace-block">
      <div class="trace-block-h">Input ${inputs.length > 1 ? i + 1 : ''}</div>
      <div style="margin-bottom:6px">${head}</div>
      ${counts}
      ${verdictRows ? `<div class="trace-table-wrap"><table class="trace-table"><thead><tr><th>write</th><th>fact</th><th>dedup</th></tr></thead><tbody>${verdictRows}</tbody></table></div>` : '<span class="muted text-xs">no facts extracted</span>'}
    </div>`);
  });

  return parts.join('') || `<pre class="trace-json">${escape(JSON.stringify(d, null, 2))}</pre>`;
}

function dedupExplain(a) {
  return escape(a.decision || '');
}

function traceBlock(title, html) { return `<div class="trace-block"><div class="trace-block-h">${escape(title)}</div><div>${html}</div></div>`; }
function kvline(k, v) { return `<span class="kvline"><span class="muted">${escape(k)}</span> ${escape(sc(v))}</span>`; }
function clock(iso) { return (iso || '').slice(11, 19) || (iso || '').slice(0, 10); }

function traceBadge(kind) {
  if (kind === 'ingest' || kind === 'remember' || kind === 'correct') return 'ok';
  return 'info';
}
function agentBadge(agent) {
  if (agent === 'claude-code') return 'info';
  if (agent === 'mcp') return 'ok';
  if (agent === 'codex') return 'warn';
  if (agent === 'cursor') return 'accent';
  return ''; // cli + unknown → neutral
}
function dedupBadge(action) {
  const a = String(action || '').toUpperCase();
  if (a === 'ADD') return 'ok';
  if (a === 'SKIP') return '';
  if (a === 'UPDATE') return 'info';
  if (a === 'CONTRADICT') return 'err';
  return 'info';
}
function opBadge(type) {
  if (type.startsWith('write.')) return 'ok';
  if (type.startsWith('error')) return 'err';
  if (type === 'meta.dropped') return 'warn';
  return 'info';
}
function opSummary(evt) {
  if (evt.type === 'rpc.connected')    return `client ${escape(evt.name || evt.agent || 'local')} connected`;
  if (evt.type === 'rpc.disconnected') return `client ${escape(evt.agent || 'local')} disconnected`;
  if (evt.type === 'rpc.denied')       return `denied ${escape(evt.method)} (${escape(evt.code)})`;
  if (evt.type === 'meta.dropped')     return `${evt.count} live events dropped (backpressure)`;
  return `<code class="mono">${escape(JSON.stringify(evt))}</code>`;
}

// Filter chips + actions
$('#trace-filters')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-trace-filter]');
  if (!chip) return;
  traceFilter = chip.dataset.traceFilter || '';
  $$('#trace-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
  loadTraces();
});
$('#trace-agent-filters')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-agent-filter]');
  if (!chip) return;
  traceAgentFilter = chip.dataset.agentFilter || '';
  $$('#trace-agent-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
  loadTraces();
});
$('#trace-refresh')?.addEventListener('click', loadTraces);
$('#trace-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear the entire trace log? This deletes persisted history.')) return;
  try { await rpc('trace.clear', { confirm: true }); } catch {}
  loadTraces();
});

// ── Modal infrastructure ────────────────────────────────────────────
function closeModal(id) { const m = document.getElementById(id); if (m) m.hidden = true; }
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-modal]');
  if (closer) { e.preventDefault(); closeModal(closer.dataset.closeModal); return; }
  if (e.target.classList && e.target.classList.contains('modal') && !e.target.hidden) closeModal(e.target.id);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const m of $$('.modal')) if (!m.hidden) { closeModal(m.id); return; }
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-copy]');
  if (!t) return;
  const node = document.getElementById(t.dataset.copy);
  if (!node) return;
  const text = Array.from(node.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'BUTTON')).map((n) => n.textContent).join('').trim();
  const ok = await copyToClipboard(text);
  const orig = t.textContent;
  t.textContent = ok ? 'copied!' : 'failed';
  setTimeout(() => { t.textContent = orig; }, 1200);
});

// ═════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════
// Branded landing splash: stays up while we check ~/.sigil (via setup.state)
// and route to setup or the dashboard, then fades out. A minimum dwell keeps
// it from flashing on a fast check.
function dismissLanding() {
  const el = $('#landing');
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(() => { el.hidden = true; }, 550);
}
async function runLanding() {
  const started = Date.now();
  try { await initSetup(); } catch { /* initSetup handles its own errors */ }
  const MIN_MS = 1100;
  setTimeout(dismissLanding, Math.max(0, MIN_MS - (Date.now() - started)));
}

const initial = (window.location.hash || '#health').slice(1);
setRoute(validRoutes.includes(initial) ? initial : 'health');
// A deep link such as `#agents` used to render its view immediately but leave
// the shared connection indicator at “connecting…” until the five-second
// background refresh. Prime the lightweight health state once for every
// non-home route so the first visible status is truthful.
if (initial !== 'health') refreshHealth();
runLanding();
setInterval(() => { if (!document.hidden) refreshHealth(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshHealth(); });
