// Sigil GUI — vanilla JS. Onboarding wizard + dashboard.
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
  if (!body.ok) throw new Error(body.error?.message || 'rpc error');
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
const formatTime = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); }
  catch { return iso; }
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
// ONBOARDING WIZARD
// ════════════════════════════════════════════════════════════════════
const wizardState = { step: 'welcome', llmProvider: null, embProvider: null, llmProviders: [], embProviders: [] };

function setOnbStep(stepId) {
  wizardState.step = stepId;
  // Update step list state — done/active/future
  const order = ['welcome', 'database', 'llm', 'embedding', 'finish'];
  const idx = order.indexOf(stepId);
  $$('.onboarding-step').forEach((el) => {
    const i = order.indexOf(el.dataset.obStep);
    el.classList.remove('active', 'done', 'future');
    if (i < idx) el.classList.add('done');
    else if (i === idx) el.classList.add('active');
    else el.classList.add('future');
  });
  // Show only the active step
  $$('.wizard-step').forEach((el) => el.classList.toggle('active', el.dataset.step === stepId));
  // Lazy-fetch provider lists when entering those steps
  if (stepId === 'llm' && !wizardState.llmProviders.length) loadLlmProviders();
  if (stepId === 'embedding' && !wizardState.embProviders.length) loadEmbeddingProviders();
  if (stepId === 'finish') renderFinish();
  // Scroll content to top
  document.querySelector('.onboarding-content')?.scrollTo(0, 0);
}

async function loadOnboardingState() {
  try {
    const state = await rpc('onboardingState');
    if (state.setupComplete) {
      $('#onboarding').hidden = true;
      return;
    }
    $('#onboarding').hidden = false;
    // Pre-fill DB step's "next" enabled if already done
    if (state.steps.database.done) {
      $('#ob-db-next').disabled = false;
    }
    if (state.steps.llm.done) {
      $('#ob-llm-next').disabled = false;
    }
    if (state.steps.embedding.done) {
      $('#ob-emb-next').disabled = false;
    }
  } catch (err) {
    // Could not reach daemon — show welcome anyway
    $('#onboarding').hidden = false;
  }
}

// ── DB step ──────────────────────────────────────────────────────────
$('#db-mode-cards')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-db-mode]');
  if (!card) return;
  $$('#db-mode-cards .provider-card').forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  card.querySelector('input').checked = true;
  $('#ob-db-url').style.display    = card.dataset.dbMode === 'url'    ? '' : 'none';
  $('#ob-db-fields').style.display = card.dataset.dbMode === 'fields' ? '' : 'none';
});
$('#db-mode-cards .provider-card')?.classList.add('selected');

function obDbParams() {
  const isUrl = $('input[name="db-mode"]:checked').value === 'url';
  if (isUrl) return { url: $('#ob-db-url-input').value.trim() };
  return {
    host: $('#ob-db-host').value.trim(),
    port: Number($('#ob-db-port').value),
    database: $('#ob-db-db').value.trim(),
    user: $('#ob-db-user').value.trim(),
    password: $('#ob-db-pass').value,
  };
}

$('#ob-db-test')?.addEventListener('click', async () => {
  const out = $('#ob-db-result');
  out.hidden = false;
  out.className = 'result';
  out.textContent = 'testing…';
  try {
    const data = await rpc('testDbConnection', obDbParams());
    out.textContent = JSON.stringify(data, null, 2);
    out.classList.add(data.ok ? 'ok' : 'err');
    if (data.ok && !data.pgvector) {
      $('#ob-db-install-pgv').hidden = false;
      $('#ob-db-migrate').hidden = true;
      $('#ob-db-next').disabled = true;
      out.textContent += '\n\npgvector is not installed yet. Click "Install pgvector".';
    } else if (data.ok) {
      $('#ob-db-install-pgv').hidden = true;
      $('#ob-db-migrate').hidden = false;
      out.textContent += '\n\npgvector is installed. Click "Run migrations" to finish.';
    } else {
      $('#ob-db-install-pgv').hidden = true;
      $('#ob-db-migrate').hidden = true;
      $('#ob-db-next').disabled = true;
    }
  } catch (err) {
    out.textContent = `ERROR: ${err.message}`;
    out.classList.add('err');
  }
});

$('#ob-db-install-pgv')?.addEventListener('click', async () => {
  const out = $('#ob-db-result');
  out.textContent += '\n\nInstalling pgvector…';
  try {
    const data = await rpc('ensurePgvector', obDbParams());
    if (data.ok && data.installed) {
      out.textContent += `\n✓ pgvector ${data.version} installed`;
      $('#ob-db-install-pgv').hidden = true;
      $('#ob-db-migrate').hidden = false;
    } else {
      out.textContent += `\n✗ ${data.error || 'unknown'} (${data.stage})`;
    }
  } catch (err) { out.textContent += `\nERROR: ${err.message}`; }
});

$('#ob-db-migrate')?.addEventListener('click', async () => {
  const out = $('#ob-db-result');
  out.textContent += '\n\nPersisting connection to ~/.sigil/.env…';
  try {
    const params = obDbParams();
    if (params.url) {
      await rpc('writeEnv', { patch: {
        SIGIL_DATABASE_URL: params.url,
        SIGIL_DB_HOST: null, SIGIL_DB_PORT: null, SIGIL_DB_NAME: null, SIGIL_DB_USER: null, SIGIL_DB_PASSWORD: null,
      } });
    } else {
      await rpc('writeEnv', { patch: {
        SIGIL_DB_HOST: params.host, SIGIL_DB_PORT: String(params.port),
        SIGIL_DB_NAME: params.database, SIGIL_DB_USER: params.user, SIGIL_DB_PASSWORD: params.password,
        SIGIL_DATABASE_URL: null,
      } });
    }
    out.textContent += '\n✓ env written. Running migrations…';
    // Pass connection params so runMigrations uses a one-shot pool against
    // the new URL — the daemon's existing pool is still bound to the
    // pre-onboarding env (localhost:5432 by default).
    const data = await rpc('runMigrations', params);
    out.textContent += `\n✓ batch ${data.batchNo}: ${data.ran.length} migrations applied (${data.against})`;
    $('#ob-db-next').disabled = false;
  } catch (err) {
    out.textContent += `\n✗ ${err.message}`;
  }
});

// ── LLM provider step ───────────────────────────────────────────────
async function loadLlmProviders() {
  try {
    const { providers } = await rpc('listLlmProviders');
    wizardState.llmProviders = providers;
    $('#ob-llm-cards').innerHTML = providers.map((p) => `
      <label class="provider-card" data-llm-id="${escape(p.id)}">
        <span class="check"></span>
        <span class="name">${escape(p.label)}${p.recommended ? ' <span class="badge info" style="margin-left:8px;">RECOMMENDED</span>' : ''}</span>
        <span class="hint">${escape(p.hint)}</span>
      </label>
    `).join('');
    // Auto-select recommended
    const recommended = providers.find((p) => p.recommended);
    if (recommended) selectLlmProvider(recommended.id);
  } catch (err) {
    $('#ob-llm-cards').innerHTML = `<div class="muted">failed: ${escape(err.message)}</div>`;
  }
}
function selectLlmProvider(id) {
  wizardState.llmProvider = id;
  $$('#ob-llm-cards .provider-card').forEach((c) => c.classList.toggle('selected', c.dataset.llmId === id));
  const p = wizardState.llmProviders.find((x) => x.id === id);
  if (!p) return;
  if (!p.fields.length) {
    $('#ob-llm-fields').innerHTML = `<p class="muted text-sm">No additional configuration needed — Sigil will use your local Claude Code subscription.</p>`;
  } else {
    $('#ob-llm-fields').innerHTML = p.fields.map((f) => `
      <label class="field">
        <span class="label">${escape(f.label)}${f.optional ? ' <span class="muted text-xs">(optional)</span>' : ''}</span>
        <input type="${f.type}" data-llm-field="${escape(f.name)}" placeholder="${escape(f.placeholder || '')}" autocomplete="off">
      </label>
    `).join('');
  }
}
$('#ob-llm-cards')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-llm-id]');
  if (card) selectLlmProvider(card.dataset.llmId);
});
$('#ob-llm-save')?.addEventListener('click', async () => {
  if (!wizardState.llmProvider) return;
  const fields = {};
  $$('#ob-llm-fields [data-llm-field]').forEach((i) => { if (i.value) fields[i.dataset.llmField] = i.value; });
  const out = $('#ob-llm-result');
  out.hidden = false; out.className = 'result'; out.textContent = 'saving…';
  try {
    await rpc('configureLlm', { id: wizardState.llmProvider, ...fields });
    out.textContent = 'env written. Testing live LLM call…';
    const test = await rpc('testLlm', {});
    if (test.ok) {
      out.classList.add('ok');
      out.textContent += `\n✓ provider responded: "${test.response}"`;
      $('#ob-llm-next').disabled = false;
    } else {
      out.classList.add('err');
      out.textContent += `\n✗ test failed: ${test.error}`;
    }
  } catch (err) {
    out.classList.add('err');
    out.textContent = `✗ ${err.message}`;
  }
});

// ── Embedding step ──────────────────────────────────────────────────
async function loadEmbeddingProviders() {
  try {
    const { providers } = await rpc('listEmbeddingProviders');
    wizardState.embProviders = providers;
    $('#ob-emb-cards').innerHTML = providers.map((p) => `
      <label class="provider-card" data-emb-id="${escape(p.id)}">
        <span class="check"></span>
        <span class="name">${escape(p.label)}${p.recommended ? ' <span class="badge info" style="margin-left:8px;">RECOMMENDED</span>' : ''}</span>
        <span class="hint">${escape(p.hint)}</span>
      </label>
    `).join('');
    const r = providers.find((p) => p.recommended);
    if (r) selectEmbProvider(r.id);
  } catch (err) {
    $('#ob-emb-cards').innerHTML = `<div class="muted">failed: ${escape(err.message)}</div>`;
  }
}
function selectEmbProvider(id) {
  wizardState.embProvider = id;
  $$('#ob-emb-cards .provider-card').forEach((c) => c.classList.toggle('selected', c.dataset.embId === id));
  const p = wizardState.embProviders.find((x) => x.id === id);
  if (!p) return;
  const visibleFields = p.fields.filter((f) => !f.sharedWith);
  if (!visibleFields.length) {
    const sharedNote = p.fields.find((f) => f.sharedWith === 'llm')
      ? '<p class="muted text-sm">Reuses the API key from your LLM step.</p>'
      : '<p class="muted text-sm">No configuration needed.</p>';
    $('#ob-emb-fields').innerHTML = sharedNote;
  } else {
    $('#ob-emb-fields').innerHTML = visibleFields.map((f) => `
      <label class="field">
        <span class="label">${escape(f.label)}</span>
        <input type="${f.type}" data-emb-field="${escape(f.name)}" placeholder="${escape(f.placeholder || '')}" autocomplete="off">
      </label>
    `).join('');
  }
}
$('#ob-emb-cards')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-emb-id]');
  if (card) selectEmbProvider(card.dataset.embId);
});
$('#ob-emb-save')?.addEventListener('click', async () => {
  if (!wizardState.embProvider) return;
  const fields = {};
  $$('#ob-emb-fields [data-emb-field]').forEach((i) => { if (i.value) fields[i.dataset.embField] = i.value; });
  const out = $('#ob-emb-result');
  out.hidden = false; out.className = 'result'; out.textContent = 'saving…';
  try {
    await rpc('configureEmbedding', { id: wizardState.embProvider, ...fields });
    out.textContent = 'env written. Testing embed call…';
    const test = await rpc('testEmbedding', {});
    if (test.ok) {
      out.classList.add('ok');
      out.textContent += `\n✓ embedder returned ${test.dim}-dim vector`;
      $('#ob-emb-next').disabled = false;
    } else {
      out.classList.add('err');
      out.textContent += `\n✗ test failed: ${test.error}`;
    }
  } catch (err) {
    out.classList.add('err');
    out.textContent = `✗ ${err.message}`;
  }
});

// ── Finish step ─────────────────────────────────────────────────────
async function renderFinish() {
  try {
    const [ping, state] = await Promise.all([rpc('ping'), rpc('onboardingState')]);
    $('#ob-finish-daemon').textContent = `pid ${ping.pid} · up ${formatUptime(ping.uptimeMs)}`;
    $('#ob-finish-db').textContent = state.steps.database.done
      ? `${state.steps.database.migrationsRan} migrations · pgvector ${state.steps.database.pgvector ? '✓' : '✗'}`
      : 'not configured';
    $('#ob-finish-llm').textContent = state.env.llmProvider || 'not configured';
    $('#ob-finish-emb').textContent = state.env.embeddingProvider
      ? `${state.env.embeddingProvider} · ${state.env.embeddingModel} · ${state.env.embeddingDim}d`
      : 'not configured';
  } catch { /* ignore */ }
}
$('#ob-complete')?.addEventListener('click', async () => {
  try { await rpc('markOnboardingComplete'); }
  catch { /* ignore */ }
  $('#onboarding').hidden = true;
  refreshHealth();
});

// ── Navigation between wizard steps ──────────────────────────────────
document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-ob-next]');
  if (n) { e.preventDefault(); setOnbStep(n.dataset.obNext); return; }
  const b = e.target.closest('[data-ob-back]');
  if (b) { e.preventDefault(); setOnbStep(b.dataset.obBack); return; }
});

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

const validRoutes = ['health', 'kb', 'devices', 'activity', 'setup', 'settings', 'methods'];
function setRoute(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  window.location.hash = name;
  if (name === 'health')   refreshHealth();
  if (name === 'kb')       refreshKb();
  if (name === 'methods')  refreshMethods();
  if (name === 'settings') refreshEnv();
  if (name === 'devices')  refreshDevices();
  if (name === 'activity') ensureActivityWs();
}
function routeFromHash() {
  const r = (window.location.hash || '#health').slice(1);
  return validRoutes.includes(r) ? r : 'health';
}
window.addEventListener('hashchange', () => setRoute(routeFromHash()));
$$('nav a').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); setRoute(a.dataset.route); });
});

async function refreshHealth() {
  try {
    const [ping, nodeInfo, mode] = await Promise.all([
      rpc('ping'),
      rpc('nodeInfo').catch(() => ({ enabled: false })),
      rpc('mode').catch(() => ({})),
    ]);
    $('#hc-pid').textContent = `pid ${ping.pid}`;
    $('#hc-uptime').textContent = `up ${formatUptime(ping.uptimeMs)} · ${ping.node}`;
    $('#hc-mode').textContent = mode.mode || '—';
    $('#hc-driver').textContent = mode.memoryClient ? `memory client: ${mode.memoryClient}` : '—';
    if (nodeInfo.enabled && nodeInfo.nodeId) {
      $('#hc-nodeid').textContent = nodeInfo.nodeId.slice(0, 12) + '…';
      $('#hc-nodeid').title = nodeInfo.nodeId;
      $('#hc-relay').textContent = nodeInfo.relayUrl ? new URL(nodeInfo.relayUrl).hostname : 'no relay';
    } else {
      $('#hc-nodeid').textContent = '—';
      $('#hc-relay').textContent = 'Iroh disabled';
    }
    $('#brand-badge').textContent = mode.mode || 'solo';

    const rows = [
      ['daemon pid', ping.pid], ['version', ping.version], ['node.js', ping.node],
      ['uptime', formatUptime(ping.uptimeMs)], ['mode', mode.mode || '—'],
      ['memory client', mode.memoryClient || '—'],
    ];
    if (mode.masterNodeId) rows.push(['master nodeId', mode.masterNodeId]);
    if (nodeInfo.enabled) {
      rows.push(['this nodeId', nodeInfo.nodeId || nodeInfo.error || '—']);
      if (nodeInfo.relayUrl) rows.push(['relay', nodeInfo.relayUrl]);
      if (nodeInfo.addresses?.length) rows.push(['addresses', nodeInfo.addresses.join(', ')]);
    }
    renderKv($('#health-pane'), rows);

    $('#footer-version').textContent = `v${ping.version}`;
    $('#footer-pid').textContent = ping.pid;

    setConn('ok', 'connected');
  } catch (err) { setConn('err', err.message); }
}

async function refreshKb() {
  try {
    const data = await rpc('status', {});
    renderKv($('#kb-pane'), [
      ['documents', data.documents], ['chunks', data.chunks], ['facts', data.facts],
      ['entities (docs)', data.entities.documents],
      ['entities (people)', data.entities.people],
      ['entities (topics)', data.entities.topics],
      ['relations', data.relations],
      ['hebbian edges', data.hebbian?.edgeCount ?? '—'],
    ]);
    const hot = data.hotFacts || [];
    $('#hot-facts').innerHTML = hot.length
      ? hot.map((f) => `<li>${escape(f.content.slice(0, 140))}<span class="muted" style="margin-left:8px;">${f.accessCount}×</span></li>`).join('')
      : '<li class="muted">no hot facts yet</li>';
  } catch (err) {
    $('#kb-pane').innerHTML = `<div class="row"><div class="k">error</div><div class="v">${escape(err.message)}</div></div>`;
  }
}
$('#kb-refresh')?.addEventListener('click', refreshKb);

async function refreshMethods() {
  try {
    const res = await fetch('/api/v1/methods', { credentials: 'same-origin' });
    const body = await res.json();
    $('#methods-list').innerHTML = body.data.methods.map((m) => `<li><span class="badge info">RPC</span>${escape(m)}</li>`).join('');
  } catch (err) {
    $('#methods-list').innerHTML = `<li class="muted">${escape(err.message)}</li>`;
  }
}

async function refreshEnv() {
  try {
    const data = await rpc('readEnv', {});
    const tbody = $('#env-table tbody');
    const rows = Object.entries(data.entries).sort(([a], [b]) => a.localeCompare(b));
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="2" class="empty">no entries</td></tr>'; return; }
    tbody.innerHTML = rows.map(([k, v]) => v.masked
      ? `<tr><td class="mono">${escape(k)}</td><td>${v.hasValue ? '<span class="badge ok">configured</span>' : '<span class="badge">empty</span>'}</td></tr>`
      : `<tr><td class="mono">${escape(k)}</td><td class="mono">${escape(v.value)}</td></tr>`
    ).join('');
  } catch (err) {
    $('#env-table tbody').innerHTML = `<tr><td colspan="2" class="empty">${escape(err.message)}</td></tr>`;
  }
}

let ws = null;
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
  ws.addEventListener('message', (e) => { try { appendEvent(JSON.parse(e.data)); } catch {} });
}
function setActivityStatus(state, label) { const el = $('#activity-status'); el.className = `conn-status ${state}`; el.textContent = label; }
function appendEvent(evt) {
  $('#activity-empty').style.display = 'none';
  const ul = $('#activity-feed');
  const li = document.createElement('li');
  li.className = 'event';
  const ts = (evt.ts || '').slice(11, 19);
  li.innerHTML = `<span class="ts">${escape(ts)}</span><span class="badge ${badgeClass(evt.type)}">${escape(evt.type)}</span><span>${summarizeEvent(evt)}</span>`;
  ul.prepend(li);
  while (ul.childNodes.length > 200) ul.removeChild(ul.lastChild);
}
function summarizeEvent(evt) {
  if (evt.type === 'write.fact')     return `added=${evt.added} updated=${evt.updated} known=${evt.alreadyKnown} ns=${escape(evt.namespace)}`;
  if (evt.type === 'write.document') return `<code class="mono">${escape(evt.title)}</code> chunks=${evt.chunkCount} facts+${evt.factsAdded}${evt.skipped ? ' [skipped]' : ''}`;
  if (evt.type === 'read.search')    return `q=<code class="mono">${escape(evt.query)}</code> facts=${evt.factCount} chunks=${evt.chunkCount}`;
  if (evt.type === 'rpc.connected')   return `device ${escape(evt.name || evt.deviceId)}`;
  if (evt.type === 'rpc.disconnected')return `device ${escape(evt.deviceId)}`;
  if (evt.type === 'pair.consumed')   return `${escape(evt.deviceName)}`;
  if (evt.type === 'pair.rejected')   return `reason=${escape(evt.code)}`;
  if (evt.type === 'device.revoked')  return `device ${escape(evt.deviceId)} reason=${escape(evt.reason)}`;
  if (evt.type === 'meta.dropped')    return `(${evt.count} events dropped)`;
  return `<code class="mono">${escape(JSON.stringify(evt))}</code>`;
}
function badgeClass(type) {
  if (type.startsWith('write.')) return 'ok';
  if (type.startsWith('error')) return 'err';
  if (type.startsWith('pair.rej')) return 'err';
  if (type.startsWith('device.rev')) return 'warn';
  if (type === 'meta.dropped') return 'warn';
  return 'info';
}
$('#activity-clear')?.addEventListener('click', () => { $('#activity-feed').innerHTML = ''; $('#activity-empty').style.display = 'block'; });

// ── Setup tab (legacy DB form) ──────────────────────────────────────
$('#db-mode')?.addEventListener('change', (e) => {
  $('#db-url-pane').style.display    = e.target.value === 'url'    ? '' : 'none';
  $('#db-fields-pane').style.display = e.target.value === 'fields' ? '' : 'none';
});
$('#db-test')?.addEventListener('click', async () => {
  const out = $('#db-result');
  out.style.display = 'block'; out.className = 'result'; out.textContent = 'testing…';
  try {
    const params = $('#db-mode').value === 'url' ? { url: $('#db-url').value.trim() }
      : { host: $('#db-host').value.trim(), port: Number($('#db-port').value),
          database: $('#db-database').value.trim(), user: $('#db-user').value.trim(), password: $('#db-password').value };
    const data = await rpc('testDbConnection', params);
    out.textContent = JSON.stringify(data, null, 2);
    out.classList.add(data.ok ? 'ok' : 'err');
    $('#db-migrate').disabled = !data.ok || !data.pgvector;
    if (data.ok && !data.pgvector) {
      $('#db-pgvector').hidden = false; $('#db-pgvector').disabled = false;
      out.textContent += '\n\n⚠ pgvector not installed.';
    } else { $('#db-pgvector').hidden = true; }
  } catch (err) { out.textContent = `ERROR: ${err.message}`; out.classList.add('err'); $('#db-migrate').disabled = true; }
});
$('#db-pgvector')?.addEventListener('click', async () => {
  const out = $('#db-result');
  const params = $('#db-mode').value === 'url' ? { url: $('#db-url').value.trim() }
    : { host: $('#db-host').value.trim(), port: Number($('#db-port').value),
        database: $('#db-database').value.trim(), user: $('#db-user').value.trim(), password: $('#db-password').value };
  out.textContent += '\n\nInstalling pgvector…';
  try {
    const data = await rpc('ensurePgvector', params);
    if (data.ok && data.installed) { out.textContent += `\n✓ pgvector ${data.version} installed`; $('#db-pgvector').hidden = true; $('#db-migrate').disabled = false; }
    else { out.textContent += `\n✗ ${data.error || 'unknown'} (${data.stage})`; }
  } catch (err) { out.textContent += `\nERROR: ${err.message}`; }
});
$('#db-migrate')?.addEventListener('click', async () => {
  const out = $('#db-result');
  out.textContent += '\n\nRunning migrations…';
  try {
    const data = await rpc('runMigrations', {});
    out.textContent += `\nbatch ${data.batchNo}: ${data.ran.length} migrations applied`;
  } catch (err) { out.textContent += `\nERROR: ${err.message}`; }
});

// ── Modal infrastructure ────────────────────────────────────────────
function closeModal(id) { const m = document.getElementById(id); if (m) m.hidden = true; }
function openModal(id) {
  const m = document.getElementById(id); if (!m) return;
  m.hidden = false;
  setTimeout(() => { const f = m.querySelector('input, select, textarea, button'); if (f) f.focus(); }, 30);
}
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

// ── Devices ─────────────────────────────────────────────────────────
let revokeTargetId = null;
async function refreshDevices() {
  try {
    const { devices } = await rpc('device.list', {});
    const tbody = $('#dev-table tbody');
    $('#dev-count').textContent = `${devices.length} device${devices.length === 1 ? '' : 's'}`;
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">no devices paired yet — click <strong>+ Add device</strong></td></tr>';
    } else {
      tbody.innerHTML = devices.map((d) => {
        const statusLabel = d.active ? 'connected' : d.revokedReason === 'compromised' ? 'compromised' : 'paused';
        const statusClass = d.active ? 'ok' : d.revokedReason === 'compromised' ? 'err' : 'warn';
        const actions = d.active
          ? `<button class="btn small danger" data-revoke="${d.id}" data-name="${escape(d.name)}">Revoke</button>`
          : d.reactivatable
            ? `<button class="btn small" data-activate="${d.id}">Re-activate</button>`
            : `<span class="muted text-xs" title="revoked as compromised">re-pair only</span>`;
        return `<tr>
          <td><div class="device-name">${escape(d.name)}</div><div class="device-sub">device #${d.id}${d.meta?.hostname ? ' · ' + escape(d.meta.hostname) : ''}</div></td>
          <td class="mono" title="${escape(d.nodeId)}">${escape(d.nodeId.slice(0, 16))}…</td>
          <td><span class="badge ${d.role === 'admin' ? 'err' : d.role === 'writer' ? 'info' : ''}">${escape(d.role)}</span></td>
          <td>${escape((d.namespaces && d.namespaces.length) ? d.namespaces.join(', ') : '(all)')}</td>
          <td class="muted">${escape(formatTime(d.lastSeenAt))}</td>
          <td><span class="pill ${statusClass}">${statusLabel}</span></td>
          <td class="actions-cell">${actions}</td>
        </tr>`;
      }).join('');
    }
  } catch (err) { $('#dev-table tbody').innerHTML = `<tr><td colspan="7" class="empty">${escape(err.message)}</td></tr>`; }

  try {
    const { codes } = await rpc('pair.list', {});
    const tbody = $('#dev-codes tbody');
    if (!codes.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">no codes outstanding</td></tr>';
    } else {
      tbody.innerHTML = codes.map((c) => {
        let status, badgeCls = '';
        if (c.consumedBy) { status = `consumed by ${escape(c.consumedBy.name)}`; badgeCls = 'ok'; }
        else if (c.expired) { status = 'expired'; badgeCls = 'err'; }
        else { status = 'pending'; badgeCls = 'warn'; }
        return `<tr>
          <td class="mono">#${c.id}</td><td>${escape(c.name)}</td>
          <td><span class="badge">${escape(c.role)}</span></td>
          <td class="muted">${escape(formatTime(c.expiresAt))}</td>
          <td><span class="badge ${badgeCls}">${status}</span></td>
          <td class="actions-cell">${!c.consumedBy ? `<button class="btn small danger" data-revoke-code="${c.id}">Revoke</button>` : ''}</td>
        </tr>`;
      }).join('');
    }
  } catch (err) { $('#dev-codes tbody').innerHTML = `<tr><td colspan="6" class="empty">${escape(err.message)}</td></tr>`; }
}
$('#dev-refresh')?.addEventListener('click', refreshDevices);

document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-revoke]');
  if (r) {
    revokeTargetId = Number(r.dataset.revoke);
    $('#revoke-target-name').textContent = r.dataset.name || `device #${revokeTargetId}`;
    const def = $('input[name="revoke-reason"][value="paused"]'); if (def) def.checked = true;
    openModal('revoke-modal');
    return;
  }
  const a = e.target.closest('[data-activate]');
  if (a) rpc('device.activate', { id: Number(a.dataset.activate) }).then(refreshDevices).catch((err) => alert(err.message));
  const cb = e.target.closest('[data-revoke-code]');
  if (cb) rpc('pair.revoke', { id: Number(cb.dataset.revokeCode) }).then(refreshDevices).catch((err) => alert(err.message));
});

$('#revoke-confirm')?.addEventListener('click', async () => {
  if (revokeTargetId == null) return;
  const reason = $('input[name="revoke-reason"]:checked').value;
  try { await rpc('device.revoke', { id: revokeTargetId, reason }); closeModal('revoke-modal'); refreshDevices(); }
  catch (err) { alert(err.message); }
});

// Highlight selected radio card in revoke modal
$$('.radio-card').forEach((card) => {
  card.addEventListener('click', () => {
    const group = card.closest('.radio-card-group') || document;
    group.querySelectorAll('.radio-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
  });
});

// Add-device modal
function resetDevModal() {
  $('#dev-form').style.display = '';
  $('#dev-result-view').hidden = true;
  $('#dev-create').hidden = false;
  $('#dev-done').hidden = true;
  $('#dev-cancel').hidden = false;
  $('#dev-name').value = ''; $('#dev-ns').value = '';
  $('#dev-ttl').value = '600'; $('#dev-role').value = 'writer';
}
$('#dev-new')?.addEventListener('click', () => { resetDevModal(); openModal('dev-modal'); });
new MutationObserver(() => { if ($('#dev-modal').hidden) { setTimeout(resetDevModal, 200); refreshDevices(); } })
  .observe($('#dev-modal'), { attributes: true, attributeFilter: ['hidden'] });

$('#dev-create')?.addEventListener('click', async () => {
  const name = $('#dev-name').value.trim(); if (!name) return alert('Device name required');
  const role = $('#dev-role').value;
  const ttl = Number($('#dev-ttl').value) || 600;
  const ns = $('#dev-ns').value.trim();
  try {
    const data = await rpc('pair.create', {
      name, role, ttlSeconds: ttl,
      namespaces: ns ? ns.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
    const cmd = `sigil join ${data.masterNodeId || '<master-node-id>'} ${data.code} --name ${data.name}`;
    $('#dev-form').style.display = 'none';
    $('#dev-result-view').hidden = false;
    $('#dev-create').hidden = true; $('#dev-cancel').hidden = true; $('#dev-done').hidden = false;
    $('#dev-result-code').firstChild.textContent = data.code + ' ';
    $('#dev-result-master').firstChild.textContent = (data.masterNodeId || '(iroh not running)') + ' ';
    $('#dev-result-cmd').textContent = cmd;
    $('#dev-result-expiry').textContent = data.expiresAt;
  } catch (err) { alert(`Create failed: ${err.message}`); }
});

// ════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════
const initial = (window.location.hash || '#health').slice(1);
setRoute(validRoutes.includes(initial) ? initial : 'health');
loadOnboardingState();
setInterval(refreshHealth, 5000);
