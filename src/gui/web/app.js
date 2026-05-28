// Sigil GUI — vanilla JS. Talks to the daemon via HTTP+cookie auth and
// subscribes to live events over WebSocket.

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ── RPC ─────────────────────────────────────────────────────────────
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

// ── Helpers ─────────────────────────────────────────────────────────
function escape(v) {
  if (v === null || v === undefined) return '—';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
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

function formatTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); }
  catch { return iso; }
}

function setConn(state, label) {
  const el = $('#conn');
  el.className = `conn-status ${state}`;
  el.textContent = label;
}

function renderDl(node, entries) {
  node.innerHTML = entries.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); return true; }
    catch { return false; }
    finally { document.body.removeChild(ta); }
  }
}

// ── Router ──────────────────────────────────────────────────────────
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

// ── Overview / Health ───────────────────────────────────────────────
async function refreshHealth() {
  try {
    const [ping, nodeInfo, mode] = await Promise.all([
      rpc('ping'),
      rpc('nodeInfo').catch(() => ({ enabled: false })),
      rpc('mode').catch(() => ({})),
    ]);

    // Banner cards
    $('#hc-pid').textContent = `pid ${ping.pid}`;
    $('#hc-uptime').textContent = `up ${formatUptime(ping.uptimeMs)} · ${ping.node}`;
    $('#hc-mode').textContent = mode.mode || '—';
    $('#hc-driver').textContent = mode.memoryClient
      ? `memory client: ${mode.memoryClient}`
      : 'no memory client';
    if (nodeInfo.enabled && nodeInfo.nodeId) {
      $('#hc-nodeid').textContent = nodeInfo.nodeId.slice(0, 12) + '…';
      $('#hc-nodeid').title = nodeInfo.nodeId;
      $('#hc-relay').textContent = nodeInfo.relayUrl
        ? `relay: ${new URL(nodeInfo.relayUrl).hostname}`
        : 'no relay';
    } else {
      $('#hc-nodeid').textContent = 'no identity';
      $('#hc-relay').textContent = 'Iroh disabled (solo mode)';
    }

    // Brand badge
    $('#brand-badge').textContent = mode.mode || 'solo';

    // Details panel
    const rows = [
      ['daemon pid', ping.pid],
      ['version', ping.version],
      ['node.js', ping.node],
      ['uptime', formatUptime(ping.uptimeMs)],
      ['mode', mode.mode || '—'],
      ['memory client', mode.memoryClient || '—'],
    ];
    if (mode.masterNodeId) rows.push(['master nodeId', mode.masterNodeId]);
    if (nodeInfo.enabled) {
      rows.push(['this nodeId', nodeInfo.nodeId || nodeInfo.error || '—']);
      if (nodeInfo.relayUrl) rows.push(['relay', nodeInfo.relayUrl]);
      if (nodeInfo.addresses?.length) rows.push(['addresses', nodeInfo.addresses.join(', ')]);
    }
    renderDl($('#health-pane'), rows);

    // Footer
    $('#footer-version').textContent = `v${ping.version}`;
    $('#footer-pid').textContent = ping.pid;

    setConn('ok', 'connected');
  } catch (err) {
    setConn('err', err.message);
  }
}

// ── Knowledge Base ──────────────────────────────────────────────────
async function refreshKb() {
  try {
    const data = await rpc('status', {});
    renderDl($('#kb-pane'), [
      ['documents', data.documents],
      ['chunks', data.chunks],
      ['facts', data.facts],
      ['entities (docs)', data.entities.documents],
      ['entities (people)', data.entities.people],
      ['entities (topics)', data.entities.topics],
      ['relations', data.relations],
      ['hebbian edges', data.hebbian?.edgeCount ?? '—'],
    ]);
    const hot = data.hotFacts || [];
    $('#hot-facts').innerHTML = hot.length
      ? hot.map((f) => `<li>${escape(f.content.slice(0, 140))}<span class="muted" style="margin-left:6px">${f.accessCount}×</span></li>`).join('')
      : '<li class="muted">no hot facts yet — add some with <code>sigil remember</code></li>';
  } catch (err) {
    $('#kb-pane').innerHTML = `<dt>error</dt><dd>${escape(err.message)}</dd>`;
  }
}

$('#kb-refresh').addEventListener('click', refreshKb);

// ── RPC methods ─────────────────────────────────────────────────────
async function refreshMethods() {
  try {
    const res = await fetch('/api/v1/methods', { credentials: 'same-origin' });
    const body = await res.json();
    $('#methods-list').innerHTML = body.data.methods
      .map((m) => `<li><span class="badge info">RPC</span>${escape(m)}</li>`).join('');
  } catch (err) {
    $('#methods-list').innerHTML = `<li class="muted">${escape(err.message)}</li>`;
  }
}

// ── Settings ────────────────────────────────────────────────────────
async function refreshEnv() {
  try {
    const data = await rpc('readEnv', {});
    const tbody = $('#env-table tbody');
    const rows = Object.entries(data.entries).sort(([a], [b]) => a.localeCompare(b));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty">no entries</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(([k, v]) => v.masked
      ? `<tr><td class="mono">${escape(k)}</td><td>${v.hasValue ? '<span class="badge ok">configured</span>' : '<span class="badge">empty</span>'}</td></tr>`
      : `<tr><td class="mono">${escape(k)}</td><td class="mono">${escape(v.value)}</td></tr>`
    ).join('');
  } catch (err) {
    $('#env-table tbody').innerHTML = `<tr><td colspan="2" class="empty">${escape(err.message)}</td></tr>`;
  }
}

// ── Activity (WebSocket) ────────────────────────────────────────────
let ws = null;
function ensureActivityWs() {
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/v1/events`);
  ws.addEventListener('open',  () => { setActivityStatus('ok', 'live'); });
  ws.addEventListener('close', () => {
    setActivityStatus('err', 'disconnected');
    setTimeout(() => { if (location.hash === '#activity') ensureActivityWs(); }, 1500);
  });
  ws.addEventListener('error', () => { setActivityStatus('err', 'error'); });
  ws.addEventListener('message', (e) => {
    try { appendEvent(JSON.parse(e.data)); } catch { /* ignore */ }
  });
}
function setActivityStatus(state, label) {
  const el = $('#activity-status');
  el.className = `conn-status ${state}`;
  el.textContent = label;
}
function appendEvent(evt) {
  $('#activity-empty').style.display = 'none';
  const ul = $('#activity-feed');
  const li = document.createElement('li');
  li.className = 'event';
  const ts = (evt.ts || '').slice(11, 19);
  const summary = summarizeEvent(evt);
  li.innerHTML = `<span class="ts">${escape(ts)}</span><span class="badge ${badgeClass(evt.type)}">${escape(evt.type)}</span><span>${summary}</span>`;
  ul.prepend(li);
  while (ul.childNodes.length > 200) ul.removeChild(ul.lastChild);
}
function summarizeEvent(evt) {
  if (evt.type === 'write.fact')     return `added=${evt.added} updated=${evt.updated} known=${evt.alreadyKnown} ns=${escape(evt.namespace)}`;
  if (evt.type === 'write.document') return `<code class="mono">${escape(evt.title)}</code> chunks=${evt.chunkCount} facts+${evt.factsAdded}${evt.skipped ? ' [skipped]' : ''}`;
  if (evt.type === 'read.search')    return `q=<code class="mono">${escape(evt.query)}</code> facts=${evt.factCount} chunks=${evt.chunkCount}`;
  if (evt.type === 'rpc.connected')   return `device ${escape(evt.name || evt.deviceId)} (${escape((evt.nodeId || '').slice(0, 12))}…)`;
  if (evt.type === 'rpc.disconnected')return `device ${escape(evt.deviceId)}`;
  if (evt.type === 'pair.consumed')   return `${escape(evt.deviceName)} (${escape((evt.nodeId || '').slice(0, 12))}…)`;
  if (evt.type === 'pair.rejected')   return `${escape((evt.nodeId || '').slice(0, 12))}… reason=${escape(evt.code)}`;
  if (evt.type === 'device.revoked')  return `device ${escape(evt.deviceId)} reason=${escape(evt.reason)}`;
  if (evt.type === 'meta.dropped')    return `(${evt.count} events dropped — backpressure)`;
  return `<code class="mono">${escape(JSON.stringify(evt))}</code>`;
}
function badgeClass(type) {
  if (type.startsWith('write.'))    return 'ok';
  if (type.startsWith('error'))     return 'err';
  if (type.startsWith('pair.rej'))  return 'err';
  if (type.startsWith('device.rev'))return 'warn';
  if (type === 'meta.dropped')      return 'warn';
  return 'info';
}
$('#activity-clear').addEventListener('click', () => {
  $('#activity-feed').innerHTML = '';
  $('#activity-empty').style.display = 'block';
});

// ── Setup (DB testing) ─────────────────────────────────────────────
$('#db-mode').addEventListener('change', (e) => {
  $('#db-url-pane').style.display    = e.target.value === 'url'    ? '' : 'none';
  $('#db-fields-pane').style.display = e.target.value === 'fields' ? '' : 'none';
});
$('#db-test').addEventListener('click', async () => {
  const out = $('#db-result');
  out.style.display = 'block';
  out.className = 'result';
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
    out.classList.add(data.ok ? 'ok' : 'err');
    $('#db-migrate').disabled = !data.ok || !data.pgvector;
    if (data.ok && !data.pgvector) {
      $('#db-pgvector').hidden = false;
      $('#db-pgvector').disabled = false;
      out.textContent += '\n\n⚠ pgvector extension is not installed. Click "Install pgvector" — your project-owner role usually has CREATE EXTENSION permission on Neon/Supabase.';
    } else {
      $('#db-pgvector').hidden = true;
    }
  } catch (err) {
    out.textContent = `ERROR: ${err.message}`;
    out.classList.add('err');
    $('#db-migrate').disabled = true;
  }
});
$('#db-pgvector').addEventListener('click', async () => {
  const out = $('#db-result');
  const params = $('#db-mode').value === 'url'
    ? { url: $('#db-url').value.trim() }
    : {
        host: $('#db-host').value.trim(),
        port: Number($('#db-port').value),
        database: $('#db-database').value.trim(),
        user: $('#db-user').value.trim(),
        password: $('#db-password').value,
      };
  out.textContent += '\n\nInstalling pgvector…';
  try {
    const data = await rpc('ensurePgvector', params);
    if (data.ok && data.installed) {
      out.textContent += `\n✓ pgvector ${data.version} installed (provider: ${data.provider})`;
      $('#db-pgvector').hidden = true;
      $('#db-migrate').disabled = false;
    } else {
      out.textContent += `\n✗ failed: ${data.error || 'unknown'} (stage: ${data.stage})`;
    }
  } catch (err) {
    out.textContent += `\nERROR: ${err.message}`;
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

// ── Modal infrastructure (PR review #2) ────────────────────────────
// Backdrop click + Escape + X button all close. Body click does NOT
// propagate to backdrop. Each opener and closer is data-attribute
// driven so adding new modals doesn't require new bindings.

function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = false;
  // Focus first focusable input for accessibility
  setTimeout(() => {
    const focusable = m.querySelector('input, select, textarea, button');
    if (focusable) focusable.focus();
  }, 30);
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.hidden = true;
}

// Click on backdrop (the .modal element itself, not its children) closes.
document.addEventListener('click', (e) => {
  // close X / data-close-modal buttons
  const closer = e.target.closest('[data-close-modal]');
  if (closer) {
    e.preventDefault();
    closeModal(closer.dataset.closeModal);
    return;
  }
  // Backdrop click — only when target IS the backdrop, not bubble
  if (e.target.classList && e.target.classList.contains('modal') && !e.target.hidden) {
    closeModal(e.target.id);
  }
});

// Escape closes whichever modal is open
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const m of $$('.modal')) {
    if (!m.hidden) {
      closeModal(m.id);
      return;
    }
  }
});

// Copy buttons inside modals
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-copy]');
  if (!t) return;
  const targetId = t.dataset.copy;
  const node = document.getElementById(targetId);
  if (!node) return;
  // Pick the textual content, skipping nested buttons
  const text = Array.from(node.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'BUTTON'))
    .map((n) => n.textContent)
    .join('').trim();
  const ok = await copyToClipboard(text);
  const orig = t.textContent;
  t.textContent = ok ? 'copied!' : 'failed';
  setTimeout(() => { t.textContent = orig; }, 1200);
});

// ── Devices (delegation; PR review #31) ────────────────────────────
let revokeTargetId = null;

async function refreshDevices() {
  try {
    const { devices } = await rpc('device.list', {});
    const tbody = $('#dev-table tbody');
    const countEl = $('#dev-count');

    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">no devices paired yet — click <strong>+ Add device</strong> to generate a pairing code</td></tr>';
      countEl.textContent = '0 devices';
    } else {
      countEl.textContent = `${devices.length} device${devices.length === 1 ? '' : 's'}`;
      tbody.innerHTML = devices.map((d) => {
        const statusLabel = d.active
          ? 'connected'
          : d.revokedReason === 'compromised' ? 'compromised' : 'paused';
        const statusClass = d.active ? 'ok' : d.revokedReason === 'compromised' ? 'err' : 'warn';
        const actions = d.active
          ? `<button class="btn small danger" data-revoke="${d.id}" data-name="${escape(d.name)}">Revoke</button>`
          : d.reactivatable
            ? `<button class="btn small" data-activate="${d.id}">Re-activate</button>`
            : `<span class="muted" title="revoked as compromised — re-pair required">re-pair only</span>`;
        return `
          <tr>
            <td>
              <div class="device-name">${escape(d.name)}</div>
              <div class="device-sub">device #${d.id}${d.meta?.hostname ? ' · ' + escape(d.meta.hostname) : ''}</div>
            </td>
            <td class="mono" title="${escape(d.nodeId)}">${escape(d.nodeId.slice(0, 16))}…</td>
            <td><span class="badge ${d.role === 'admin' ? 'err' : d.role === 'writer' ? 'info' : ''}">${escape(d.role)}</span></td>
            <td>${escape((d.namespaces && d.namespaces.length) ? d.namespaces.join(', ') : '(all)')}</td>
            <td class="muted">${escape(formatTime(d.lastSeenAt))}</td>
            <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
            <td class="actions-cell">${actions}</td>
          </tr>`;
      }).join('');
    }
  } catch (err) {
    $('#dev-table tbody').innerHTML = `<tr><td colspan="7" class="empty">${escape(err.message)}</td></tr>`;
  }

  try {
    const { codes } = await rpc('pair.list', {});
    const tbody = $('#dev-codes tbody');
    const pending = codes.filter((c) => !c.consumedBy && !c.expired);
    if (!codes.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">no codes outstanding</td></tr>';
    } else {
      tbody.innerHTML = codes.map((c) => {
        let status;
        let badgeCls = '';
        if (c.consumedBy) { status = `consumed by ${escape(c.consumedBy.name)}`; badgeCls = 'ok'; }
        else if (c.expired) { status = 'expired'; badgeCls = 'err'; }
        else { status = 'pending'; badgeCls = 'warn'; }
        return `<tr>
          <td class="mono">#${c.id}</td>
          <td>${escape(c.name)}</td>
          <td><span class="badge">${escape(c.role)}</span></td>
          <td class="muted">${escape(formatTime(c.expiresAt))}</td>
          <td><span class="badge ${badgeCls}">${status}</span></td>
          <td class="actions-cell">${!c.consumedBy ? `<button class="btn small danger" data-revoke-code="${c.id}">Revoke</button>` : ''}</td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    $('#dev-codes tbody').innerHTML = `<tr><td colspan="6" class="empty">${escape(err.message)}</td></tr>`;
  }
}

$('#dev-refresh').addEventListener('click', refreshDevices);

// Delegated handlers for both tables
let deviceTablesBound = false;
function bindDeviceTables() {
  if (deviceTablesBound) return;
  deviceTablesBound = true;

  $('#dev-table').addEventListener('click', (e) => {
    const revokeBtn = e.target.closest('[data-revoke]');
    if (revokeBtn) {
      revokeTargetId = Number(revokeBtn.dataset.revoke);
      $('#revoke-target-name').textContent = revokeBtn.dataset.name || `device #${revokeTargetId}`;
      // Default radio back to "paused"
      const def = $('input[name="revoke-reason"][value="paused"]');
      if (def) def.checked = true;
      openModal('revoke-modal');
      return;
    }
    const activateBtn = e.target.closest('[data-activate]');
    if (activateBtn) {
      rpc('device.activate', { id: Number(activateBtn.dataset.activate) })
        .then(refreshDevices)
        .catch((err) => alert(`Activate failed: ${err.message}`));
    }
  });

  $('#dev-codes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-revoke-code]');
    if (!b) return;
    rpc('pair.revoke', { id: Number(b.dataset.revokeCode) })
      .then(refreshDevices)
      .catch((err) => alert(`Revoke code failed: ${err.message}`));
  });
}

// Revoke modal confirm
$('#revoke-confirm').addEventListener('click', async () => {
  if (revokeTargetId == null) return;
  const reason = $('input[name="revoke-reason"]:checked').value;
  try {
    await rpc('device.revoke', { id: revokeTargetId, reason });
    closeModal('revoke-modal');
    refreshDevices();
  } catch (err) {
    alert(`Revoke failed: ${err.message}`);
  }
});

// ── Add-device modal ───────────────────────────────────────────────
function resetDevModal() {
  $('#dev-form').style.display = '';
  $('#dev-result-view').hidden = true;
  $('#dev-create').hidden = false;
  $('#dev-done').hidden = true;
  $('#dev-cancel').hidden = false;
  $('#dev-name').value = '';
  $('#dev-ns').value = '';
  $('#dev-ttl').value = '600';
  $('#dev-role').value = 'writer';
}

$('#dev-new').addEventListener('click', () => {
  resetDevModal();
  openModal('dev-modal');
});

// When the dev-modal closes (any path), reset for next time
const devModalObserver = new MutationObserver(() => {
  if ($('#dev-modal').hidden) {
    setTimeout(resetDevModal, 200); // after animation
    refreshDevices(); // pick up any new pairing codes
  }
});
devModalObserver.observe($('#dev-modal'), { attributes: true, attributeFilter: ['hidden'] });

$('#dev-create').addEventListener('click', async () => {
  const name = $('#dev-name').value.trim();
  if (!name) { alert('Device name is required'); return; }
  const role = $('#dev-role').value;
  const ttl = Number($('#dev-ttl').value) || 600;
  const ns = $('#dev-ns').value.trim();
  try {
    const data = await rpc('pair.create', {
      name, role, ttlSeconds: ttl,
      namespaces: ns ? ns.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
    const cmd = `sigil join ${data.masterNodeId || '<master-node-id>'} ${data.code} --name ${data.name}`;
    // Swap to result view
    $('#dev-form').style.display = 'none';
    $('#dev-result-view').hidden = false;
    $('#dev-create').hidden = true;
    $('#dev-cancel').hidden = true;
    $('#dev-done').hidden = false;
    // Fill content (preserve copy buttons by setting text on text nodes)
    const codeEl = $('#dev-result-code');
    codeEl.firstChild.textContent = data.code + ' ';
    const masterEl = $('#dev-result-master');
    masterEl.firstChild.textContent = (data.masterNodeId || '(iroh not running)') + ' ';
    $('#dev-result-cmd').textContent = cmd;
    $('#dev-result-expiry').textContent = data.expiresAt;
  } catch (err) {
    alert(`Create failed: ${err.message}`);
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────
$$('nav a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    setRoute(a.dataset.route);
  });
});

bindDeviceTables();

const validRoutes = ['health', 'kb', 'devices', 'activity', 'setup', 'settings', 'methods'];
function routeFromHash() {
  const r = (window.location.hash || '#health').slice(1);
  return validRoutes.includes(r) ? r : 'health';
}
window.addEventListener('hashchange', () => setRoute(routeFromHash()));
setRoute(routeFromHash());

// Refresh health every 5s so the connection pill stays current.
setInterval(refreshHealth, 5000);
