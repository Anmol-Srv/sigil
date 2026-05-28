// Sigil GUI shell — vanilla JS. Talks to the daemon via HTTP+cookie auth
// and subscribes to live events over WebSocket.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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

function setConn(state, label) {
  const el = $('#conn');
  el.className = `status-pill ${state}`;
  el.textContent = label;
}

function setRoute(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  window.location.hash = name;
  if (name === 'kb')       refreshKb();
  if (name === 'methods')  refreshMethods();
  if (name === 'health')   refreshHealth();
  if (name === 'settings') refreshEnv();
  if (name === 'activity') ensureActivityWs();
}

function renderDl(node, entries) {
  node.innerHTML = entries.map(([k, v]) => `<dt>${k}</dt><dd>${escape(v)}</dd>`).join('');
}

function escape(v) {
  if (v === null || v === undefined) return '—';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function refreshHealth() {
  try {
    const data = await rpc('ping');
    renderDl($('#health-pane'), [
      ['pid', data.pid],
      ['version', data.version],
      ['node', data.node],
      ['uptime', formatUptime(data.uptimeMs)],
    ]);
    setConn('ok', 'connected');
  } catch (err) {
    setConn('err', err.message);
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function refreshKb() {
  try {
    const data = await rpc('status', {});
    renderDl($('#kb-pane'), [
      ['documents', data.documents],
      ['chunks', data.chunks],
      ['facts', data.facts],
      ['entities.docs', data.entities.documents],
      ['entities.people', data.entities.people],
      ['entities.topics', data.entities.topics],
      ['relations', data.relations],
      ['hebbian edges', data.hebbian?.edgeCount ?? '—'],
    ]);
    $('#hot-facts').innerHTML = (data.hotFacts || [])
      .map((f) => `<li>${escape(f.content.slice(0, 200))} <span class="muted">(${f.accessCount}×)</span></li>`)
      .join('') || '<li class="muted">no hot facts yet</li>';
  } catch (err) {
    $('#kb-pane').innerHTML = `<dt>error</dt><dd>${escape(err.message)}</dd>`;
  }
}

async function refreshMethods() {
  try {
    const res = await fetch('/api/v1/methods', { credentials: 'same-origin' });
    const body = await res.json();
    $('#methods-list').innerHTML = body.data.methods
      .map((m) => `<li class="method"><span class="badge">RPC</span>${m}</li>`).join('');
  } catch (err) {
    $('#methods-list').innerHTML = `<li class="muted">${escape(err.message)}</li>`;
  }
}

async function refreshEnv() {
  try {
    const data = await rpc('readEnv', {});
    const tbody = $('#env-table tbody');
    const rows = Object.entries(data.entries).sort(([a], [b]) => a.localeCompare(b));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="muted">no entries</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(([k, v]) => {
      if (v.masked) {
        return `<tr><td><code>${escape(k)}</code></td><td>${v.hasValue ? '<span class="badge ok">configured</span>' : '<span class="badge">empty</span>'}</td></tr>`;
      }
      return `<tr><td><code>${escape(k)}</code></td><td><code>${escape(v.value)}</code></td></tr>`;
    }).join('');
  } catch (err) {
    $('#env-table tbody').innerHTML = `<tr><td colspan="2" class="muted">${escape(err.message)}</td></tr>`;
  }
}

// ── Activity (WebSocket) ──────────────────────────────────────────────
let ws = null;
function ensureActivityWs() {
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/v1/events`);
  ws.addEventListener('open', () => { $('#activity-status').textContent = 'live'; });
  ws.addEventListener('close', () => {
    $('#activity-status').textContent = 'disconnected';
    setTimeout(() => { if (location.hash === '#activity') ensureActivityWs(); }, 1500);
  });
  ws.addEventListener('error', () => { $('#activity-status').textContent = 'error'; });
  ws.addEventListener('message', (e) => {
    try { appendEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  });
}
function appendEvent(evt) {
  const ul = $('#activity-feed');
  const li = document.createElement('li');
  li.className = 'event';
  const summary = summarizeEvent(evt);
  li.innerHTML = `<span class="ts">${escape(evt.ts.slice(11, 19))}</span> <span class="badge ${badgeClass(evt.type)}">${escape(evt.type)}</span> <span>${summary}</span>`;
  ul.prepend(li);
  // Cap at 200 entries
  while (ul.childNodes.length > 200) ul.removeChild(ul.lastChild);
}
function summarizeEvent(evt) {
  if (evt.type === 'write.fact')     return `added=${evt.added} updated=${evt.updated} known=${evt.alreadyKnown} ns=${escape(evt.namespace)}`;
  if (evt.type === 'write.document') return `<code>${escape(evt.title)}</code> chunks=${evt.chunkCount} facts+${evt.factsAdded}${evt.skipped ? ' [skipped]' : ''}`;
  if (evt.type === 'read.search')    return `q=<code>${escape(evt.query)}</code> facts=${evt.factCount} chunks=${evt.chunkCount}`;
  return `<code>${escape(JSON.stringify(evt))}</code>`;
}
function badgeClass(type) {
  if (type.startsWith('write.')) return 'ok';
  if (type.startsWith('error'))  return 'err';
  return '';
}
$('#activity-clear').addEventListener('click', () => { $('#activity-feed').innerHTML = ''; });

// ── Setup ─────────────────────────────────────────────────────────────
$('#db-mode').addEventListener('change', (e) => {
  $('#db-url-pane').style.display    = e.target.value === 'url'    ? '' : 'none';
  $('#db-fields-pane').style.display = e.target.value === 'fields' ? '' : 'none';
});
$('#db-test').addEventListener('click', async () => {
  const out = $('#db-result');
  out.textContent = 'testing…';
  try {
    const params = $('#db-mode').value === 'url'
      ? { url: $('#db-url').value.trim() }
      : {
          host: $('#db-host').value.trim(),
          port: Number($('#db-port').value),
          database: $('#db-database').value.trim(),
          user: $('#db-user').value.trim(),
          password: $('#db-password').value,
        };
    const data = await rpc('testDbConnection', params);
    out.textContent = JSON.stringify(data, null, 2);
    $('#db-migrate').disabled = !data.ok || !data.pgvector;
    if (data.ok && !data.pgvector) {
      out.textContent += '\n\n⚠ pgvector extension is not installed. Migrations will fail until you install it (see docs).';
    }
  } catch (err) {
    out.textContent = `ERROR: ${err.message}`;
    $('#db-migrate').disabled = true;
  }
});
$('#db-migrate').addEventListener('click', async () => {
  const out = $('#db-result');
  out.textContent += '\n\nRunning migrations…';
  try {
    const data = await rpc('runMigrations', {});
    out.textContent += `\nbatch ${data.batchNo}: ${data.ran.length} migrations applied`;
    if (data.ran.length) out.textContent += '\n  ' + data.ran.join('\n  ');
  } catch (err) {
    out.textContent += `\nERROR: ${err.message}`;
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────
$$('nav a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    setRoute(a.dataset.route);
  });
});
const initial = (window.location.hash || '#health').slice(1);
setRoute(['health', 'kb', 'activity', 'setup', 'settings', 'methods'].includes(initial) ? initial : 'health');

// Refresh health every 5s so the connection pill stays current.
setInterval(refreshHealth, 5000);
