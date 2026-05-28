// Sigil GUI shell — vanilla JS. Talks to the daemon via HTTP+cookie auth.

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

function setup() {
  $$('nav a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const route = a.dataset.route;
      setRoute(route);
      if (route === 'kb') refreshKb();
      if (route === 'methods') refreshMethods();
      if (route === 'health') refreshHealth();
    });
  });
  const initial = (window.location.hash || '#health').slice(1);
  setRoute(['health', 'kb', 'methods'].includes(initial) ? initial : 'health');
  refreshHealth();
  if (initial === 'kb') refreshKb();
  if (initial === 'methods') refreshMethods();

  // Refresh health every 5s so the connection pill stays current.
  setInterval(refreshHealth, 5000);
}

setup();
