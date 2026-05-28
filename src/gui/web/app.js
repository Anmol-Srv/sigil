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
  if (name === 'devices')  refreshDevices();
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
    const [ping, nodeInfo] = await Promise.all([
      rpc('ping'),
      rpc('nodeInfo').catch(() => ({ enabled: false })),
    ]);
    const rows = [
      ['pid', ping.pid],
      ['version', ping.version],
      ['node', ping.node],
      ['uptime', formatUptime(ping.uptimeMs)],
      ['network mode', nodeInfo.mode || '—'],
    ];
    if (nodeInfo.enabled) {
      rows.push(['iroh nodeId', nodeInfo.nodeId || nodeInfo.error || '—']);
      if (nodeInfo.relayUrl) rows.push(['relay', nodeInfo.relayUrl]);
      if (nodeInfo.addresses?.length) rows.push(['addresses', nodeInfo.addresses.join(', ')]);
    } else {
      rows.push(['iroh', 'disabled (solo)']);
    }
    renderDl($('#health-pane'), rows);
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

// ── Devices ───────────────────────────────────────────────────────────
async function refreshDevices() {
  // Devices
  try {
    const { devices } = await rpc('device.list', {});
    const tbody = $('#dev-table tbody');
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">no devices paired yet</td></tr>';
    } else {
      tbody.innerHTML = devices.map((d) => {
        const statusLabel = d.active
          ? 'active'
          : d.revokedReason === 'compromised' ? 'compromised' : 'paused';
        const statusBadge = d.active ? 'ok' : d.revokedReason === 'compromised' ? 'err' : '';
        const actions = d.active
          ? `<button data-revoke="${d.id}">Revoke</button>`
          : d.reactivatable
            ? `<button data-activate="${d.id}">Re-activate</button>`
            : `<span class="muted" title="revoked as compromised — re-pair required">re-pair only</span>`;
        return `
          <tr>
            <td>${escape(d.name)}</td>
            <td><code>${escape(d.nodeId.slice(0, 16))}…</code></td>
            <td><span class="badge ${d.role === 'admin' ? 'err' : d.role === 'writer' ? 'ok' : ''}">${escape(d.role)}</span></td>
            <td>${escape((d.namespaces && d.namespaces.length) ? d.namespaces.join(', ') : '(all)')}</td>
            <td>${escape(d.lastSeenAt ? new Date(d.lastSeenAt).toISOString().slice(0, 16).replace('T', ' ') : '—')}</td>
            <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
            <td>${actions}</td>
          </tr>`;
      }).join('');
      tbody.querySelectorAll('button[data-revoke]').forEach((b) => {
        b.addEventListener('click', async () => {
          const reason = prompt(
            'Revoke reason:\n\n  paused      — temporary (can re-activate later)\n  compromised — terminal (key leaked; only re-pairing re-enables)\n\nType "paused" or "compromised":',
            'paused',
          );
          if (!reason) return;
          if (reason !== 'paused' && reason !== 'compromised') {
            alert(`Invalid reason "${reason}" — expected "paused" or "compromised".`);
            return;
          }
          try {
            await rpc('device.revoke', { id: Number(b.dataset.revoke), reason });
          } catch (err) {
            alert(`Revoke failed: ${err.message}`);
            return;
          }
          refreshDevices();
        });
      });
      tbody.querySelectorAll('button[data-activate]').forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            await rpc('device.activate', { id: Number(b.dataset.activate) });
          } catch (err) {
            alert(`Activate failed: ${err.message}`);
            return;
          }
          refreshDevices();
        });
      });
    }
  } catch (err) {
    $('#dev-table tbody').innerHTML = `<tr><td colspan="7" class="muted">${escape(err.message)}</td></tr>`;
  }

  // Pending pairing codes
  try {
    const { codes } = await rpc('pair.list', {});
    const tbody = $('#dev-codes tbody');
    if (!codes.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">no codes outstanding</td></tr>';
    } else {
      tbody.innerHTML = codes.map((c) => {
        const status = c.consumedBy ? `consumed by ${escape(c.consumedBy.name)}` : c.expired ? 'EXPIRED' : 'pending';
        return `<tr>
          <td>${c.id}</td>
          <td>${escape(c.name)}</td>
          <td>${escape(c.role)}</td>
          <td>${escape(new Date(c.expiresAt).toISOString().slice(0, 16).replace('T', ' '))}</td>
          <td>${status}</td>
          <td>${!c.consumedBy ? `<button data-revoke-code="${c.id}">Revoke</button>` : ''}</td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('button[data-revoke-code]').forEach((b) => {
        b.addEventListener('click', async () => {
          await rpc('pair.revoke', { id: Number(b.dataset.revokeCode) });
          refreshDevices();
        });
      });
    }
  } catch (err) {
    $('#dev-codes tbody').innerHTML = `<tr><td colspan="6" class="muted">${escape(err.message)}</td></tr>`;
  }
}

function openDevModal() {
  $('#dev-modal').hidden = false;
  $('#dev-code-result').hidden = true;
  $('#dev-name').focus();
}
function closeDevModal() { $('#dev-modal').hidden = true; }

$('#dev-new').addEventListener('click', openDevModal);
$('#dev-refresh').addEventListener('click', refreshDevices);
$('#dev-cancel').addEventListener('click', closeDevModal);
$('#dev-create').addEventListener('click', async () => {
  const name = $('#dev-name').value.trim();
  if (!name) return alert('Device name is required');
  const role = $('#dev-role').value;
  const ttl = Number($('#dev-ttl').value) || 600;
  const ns = $('#dev-ns').value.trim();
  try {
    const data = await rpc('pair.create', {
      name, role, ttlSeconds: ttl,
      namespaces: ns ? ns.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
    const cmd = `sigil join ${data.masterNodeId || '<master-node-id>'} ${data.code} --name ${data.name}`;
    $('#dev-code-result').textContent =
      `code:          ${data.code}\n`
      + `master nodeId: ${data.masterNodeId || '(iroh not running)'}\n`
      + `expires at:    ${data.expiresAt}\n\n`
      + `On the joining device, run:\n  ${cmd}`;
    $('#dev-code-result').hidden = false;
    refreshDevices();
  } catch (err) {
    $('#dev-code-result').textContent = `ERROR: ${err.message}`;
    $('#dev-code-result').hidden = false;
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
setRoute(['health', 'kb', 'devices', 'activity', 'setup', 'settings', 'methods'].includes(initial) ? initial : 'health');

// Refresh health every 5s so the connection pill stays current.
setInterval(refreshHealth, 5000);
