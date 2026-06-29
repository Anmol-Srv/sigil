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

const validRoutes = ['health', 'kb', 'graph', 'devices', 'activity', 'setup', 'settings', 'methods'];
function setRoute(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  window.location.hash = name;
  if (name === 'health')   refreshHealth();
  if (name === 'kb')       refreshKb();
  if (name === 'graph')    initGraphView();
  if (name === 'methods')  refreshMethods();
  if (name === 'settings') { refreshEnv(); refreshSettingsClients(); }
  if (name === 'devices')  refreshDevices();
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

// ════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE — master-detail browser (facts · entities · pods + graph)
// ════════════════════════════════════════════════════════════════════
const kb = {
  tab: 'facts',
  loaded: false,
  facts: [],          // full fetched set (cross-namespace)
  factNs: null,       // active namespace filter (null = all)
  factCat: null,      // active category filter (null = all)
  factSearch: '',
  selectedFactUid: null,
  entityType: null,   // active entity-type filter
  entitySearch: '',
  entities: [],
  selectedEntityId: null,
  pods: null,
};

const ENTITY_TYPES = ['person', 'topic', 'document'];

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
  if (!kb.loaded || kb.tab === 'facts') await kbLoadFacts();
  kb.loaded = true;
  kbSetTab(kb.tab, { force: true });
}

async function kbLoadStats() {
  const strip = $('#kb-stats');
  try {
    const d = await rpc('status', {});
    const ents = (d.entities?.documents || 0) + (d.entities?.people || 0) + (d.entities?.topics || 0);
    const stats = [
      ['Facts', d.facts], ['Entities', ents], ['Relations', d.relations],
      ['Documents', d.documents], ['Chunks', d.chunks],
      ['Hebbian edges', d.hebbian?.edgeCount ?? 0],
    ];
    strip.innerHTML = stats.map(([k, v]) =>
      `<div class="kb-stat"><span class="kb-stat-v">${escape(v)}</span><span class="kb-stat-k">${escape(k)}</span></div>`).join('');
  } catch (err) {
    strip.innerHTML = `<div class="kb-stat-err">Couldn’t load totals: ${escape(err.message)}</div>`;
  }
}

function kbSetTab(name, { force = false } = {}) {
  if (!force && kb.tab === name) return;
  kb.tab = name;
  $$('.kb-tab').forEach((t) => {
    const on = t.dataset.kbtab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#kb-tab-facts').hidden = name !== 'facts';
  $('#kb-tab-entities').hidden = name !== 'entities';
  $('#kb-tab-pods').hidden = name !== 'pods';
  if (name === 'facts') kbRenderFacts();
  if (name === 'entities' && !kb.entities.length && !kb.entitySearch) kbSearchEntities();
  if (name === 'pods' && !kb.pods) kbLoadPods();
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

  const ents = (ctx.entities || []).length
    ? `<div class="kb-block"><div class="trace-block-h">Linked entities</div><div class="kb-chip-wrap">${ctx.entities.map((e) =>
        `<button class="kb-entity-chip" data-entity-id="${e.id}" type="button"><span class="kb-etype ${escape(e.entityType)}"></span>${escape(e.name)}</button>`).join('')}</div></div>`
    : '';

  const rels = (ctx.relations || []).length
    ? `<div class="kb-block"><div class="trace-block-h">Relations</div>${ctx.relations.map((r) =>
        `<div class="kb-rel"><span class="kb-rel-node">${escape(r.sourceName)}</span><span class="kb-rel-type">${escape(titleCase(r.relationType))}</span><span class="kb-rel-node">${escape(r.targetName)}</span></div>`).join('')}</div>`
    : '';

  return `<div class="kb-detail-pad">
    <div class="kb-detail-head">
      <div class="kb-badges">${badges.join('')}</div>
      <button class="btn ghost small kb-forget" data-uid="${escape(f.uid)}" type="button" title="Forget this fact">Forget</button>
    </div>
    <p class="kb-fact-body">${escape(f.content)}</p>
    ${metaBlock}${docs}${ents}${rels}
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

// ── Entities ─────────────────────────────────────────────────────────
function kbRenderEntityTypeChips() {
  const chip = (label, active, val) =>
    `<button class="chip${active ? ' active' : ''}" data-kbetype="${val === null ? '' : val}" type="button">${escape(label)}</button>`;
  $('#kb-entity-type').innerHTML = [
    chip('All', kb.entityType === null, null),
    ...ENTITY_TYPES.map((t) => chip(titleCase(t), kb.entityType === t, t)),
  ].join('');
}

async function kbSearchEntities() {
  kbRenderEntityTypeChips();
  const list = $('#kb-entity-list');
  list.innerHTML = kbSkeleton(6);
  const params = {};
  if (kb.entitySearch.trim()) params.query = kb.entitySearch.trim();
  if (kb.entityType) params.entityType = kb.entityType;
  if (!params.query && !params.entityType) params.entityType = 'topic'; // a sensible default browse
  try {
    const { entities } = await rpc('searchEntity', { ...params, limit: 50 });
    kb.entities = entities || [];
    kbRenderEntityList();
  } catch (err) {
    list.innerHTML = `<div class="empty">Couldn’t load entities: ${escape(err.message)}</div>`;
  }
}

function kbRenderEntityList() {
  const list = $('#kb-entity-list');
  if (!kb.entities.length) {
    list.innerHTML = `<div class="empty">No entities found${kb.entitySearch ? ` for “${escape(kb.entitySearch)}”` : ''}. Try another name or type.</div>`;
    return;
  }
  list.innerHTML = kb.entities.map((e) => {
    const sel = e.id === kb.selectedEntityId ? ' selected' : '';
    return `<button class="kb-row${sel}" role="option" aria-selected="${sel ? 'true' : 'false'}" data-entity-id="${e.id}" type="button">
      <span class="kb-row-main"><span class="kb-etype ${escape(e.entityType)}"></span><span class="kb-row-text">${escape(e.name)}</span></span>
      <span class="kb-row-meta"><span class="kb-mentions">${escape(e.mentionCount || 0)}×</span></span>
    </button>`;
  }).join('');
}

async function kbSelectEntity(id) {
  kb.selectedEntityId = Number(id);
  // If entity isn't on the entities tab list, still highlight when present.
  $$('#kb-entity-list .kb-row').forEach((r) => r.classList.toggle('selected', Number(r.dataset.entityId) === kb.selectedEntityId));
  const pane = $('#kb-entity-detail');
  pane.classList.add('open');
  pane.innerHTML = `<div class="kb-detail-pad">${kbSkeleton(4)}</div>`;
  try {
    const ctx = await rpc('getEntityContext', { entityId: Number(id) });
    if (ctx.notFound) { pane.innerHTML = `<div class="kb-detail-pad"><div class="empty">Entity not found.</div></div>`; return; }
    pane.innerHTML = kbRenderEntityDetail(ctx);
  } catch (err) {
    pane.innerHTML = `<div class="kb-detail-pad"><div class="empty">Couldn’t load detail: ${escape(err.message)}</div></div>`;
  }
}

function kbRenderEntityDetail(ctx) {
  const e = ctx.entity;
  const facts = (ctx.facts || []).length
    ? `<div class="kb-block"><div class="trace-block-h">Facts (${ctx.facts.length})</div>${ctx.facts.map((f) =>
        `<div class="kb-mini-fact">${escape(f.content)}</div>`).join('')}</div>`
    : '';
  const rels = (ctx.relations || []).length
    ? `<div class="kb-block"><div class="trace-block-h">Relations (${ctx.relations.length})</div>${ctx.relations.map((r) =>
        `<button class="kb-rel kb-rel-btn" data-entity-id="${r.entityId}" type="button"><span class="kb-rel-type">${escape(titleCase(r.relationType))}</span><span class="kb-rel-node"><span class="kb-etype ${escape(r.entityType)}"></span>${escape(r.name)}</span></button>`).join('')}</div>`
    : '';
  return `<div class="kb-detail-pad">
    <div class="kb-detail-head">
      <div>
        <div class="kb-entity-title"><span class="kb-etype ${escape(e.entityType)}"></span>${escape(e.name)}</div>
        <div class="kb-entity-sub">${escape(titleCase(e.entityType))} · ${escape(e.mentionCount || 0)} mention${e.mentionCount === 1 ? '' : 's'}</div>
      </div>
      <button class="btn small kb-graph-open" data-entity-id="${e.id}" data-name="${escape(e.name)}" type="button">View graph</button>
    </div>
    ${e.description ? `<p class="kb-fact-body">${escape(e.description)}</p>` : ''}
    <div class="kb-graph-mount" id="kb-graph-mount" hidden></div>
    ${rels}${facts}
  </div>`;
}

// ── Pods ─────────────────────────────────────────────────────────────
async function kbLoadPods() {
  const list = $('#kb-pod-list');
  list.innerHTML = kbSkeleton(5);
  try {
    const { pods } = await rpc('listPods', { limit: 50 });
    kb.pods = pods || [];
    if (!kb.pods.length) {
      list.innerHTML = `<div class="empty">No pods yet. Pods group facts by session and project as your agents work.</div>`;
      return;
    }
    list.innerHTML = `<div class="kb-pod-head"><span>Pod</span><span>Type</span><span>Facts</span><span>Docs</span><span>Updated</span></div>` +
      kb.pods.map((p) =>
        `<div class="kb-pod-row">
          <span class="kb-pod-name">${escape(p.name || p.uid)}</span>
          <span class="kb-tag">${escape(p.podType || '—')}</span>
          <span class="kb-pod-num">${escape(p.memberFactCount)}</span>
          <span class="kb-pod-num">${escape(p.memberDocCount)}</span>
          <span class="kb-pod-when">${escape(p.updatedAt ? formatTime(p.updatedAt) : '—')}</span>
        </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">Couldn’t load pods: ${escape(err.message)}</div>`;
  }
}

// ── Interactive relationship graph (hand-rolled SVG) ─────────────────
async function kbOpenGraph(entityId, name) {
  const mount = $('#kb-graph-mount');
  if (!mount) return;
  mount.hidden = false;
  mount.innerHTML = `<div class="kb-graph-loading">${kbSkeleton(2)}</div>`;
  try {
    const res = await rpc('traverseGraph', { startEntityId: Number(entityId), action: 'neighbors', maxDepth: 1, limit: 14 });
    if (res.notFound) { mount.innerHTML = `<div class="empty">No graph for this entity.</div>`; return; }
    kbRenderGraph(mount, res.start || { id: Number(entityId), name }, res.relations || []);
  } catch (err) {
    mount.innerHTML = `<div class="empty">Couldn’t build graph: ${escape(err.message)}</div>`;
  }
}

function kbRenderGraph(mount, center, relations) {
  const W = mount.clientWidth || 520;
  const H = 320;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 56;
  const neighbors = relations.slice(0, 12);

  if (!neighbors.length) {
    mount.innerHTML = `<div class="kb-graph-empty"><div class="kb-node focal"><span>${escape(center.name)}</span></div><p class="muted">No relations recorded for this entity yet.</p></div>`;
    return;
  }

  const nodes = [{ id: center.id, name: center.name, type: center.entityType, x: cx, y: cy, focal: true }];
  const edges = [];
  neighbors.forEach((r, i) => {
    const ang = (i / neighbors.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(ang) * R;
    const y = cy + Math.sin(ang) * R;
    nodes.push({ id: r.entityId, name: r.name, type: r.entityType, x, y, focal: false });
    edges.push({ from: 0, to: nodes.length - 1, label: titleCase(r.relationType) });
  });

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'kb-graph-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(H));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Relationship graph for ${center.name}`);

  const edgeLayer = document.createElementNS(ns, 'g');
  const labelLayer = document.createElementNS(ns, 'g');
  const nodeLayer = document.createElementNS(ns, 'g');
  svg.append(edgeLayer, labelLayer, nodeLayer);

  function draw() {
    edgeLayer.replaceChildren();
    labelLayer.replaceChildren();
    for (const e of edges) {
      const a = nodes[e.from], b = nodes[e.to];
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('class', 'kb-edge');
      edgeLayer.appendChild(line);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', mx); t.setAttribute('y', my - 3);
      t.setAttribute('class', 'kb-edge-label');
      t.setAttribute('text-anchor', 'middle');
      t.textContent = e.label;
      labelLayer.appendChild(t);
    }
  }

  function nodeEl(n, _idx) {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', `kb-node-g${n.focal ? ' focal' : ''}`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', n.focal ? `${n.name} (focus)` : `${n.name}, expand`);
    const label = (n.name || '').length > 16 ? n.name.slice(0, 15) + '…' : n.name;
    const w = Math.max(54, label.length * 7.4 + 20);
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', -w / 2); rect.setAttribute('y', -13);
    rect.setAttribute('width', w); rect.setAttribute('height', 26);
    rect.setAttribute('rx', '2');
    rect.setAttribute('class', `kb-node-box type-${n.type || 'topic'}`);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('class', 'kb-node-label');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '4');
    text.textContent = label;
    g.append(rect, text);
    positionNode(g, n);

    // drag
    let dragging = false, moved = false, ox = 0, oy = 0;
    g.addEventListener('pointerdown', (ev) => {
      dragging = true; moved = false;
      ox = ev.clientX; oy = ev.clientY;
      g.setPointerCapture(ev.pointerId);
      g.classList.add('dragging');
    });
    g.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const scale = W / svg.getBoundingClientRect().width;
      const dx = (ev.clientX - ox) * scale, dy = (ev.clientY - oy) * scale;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      n.x += dx; n.y += dy; ox = ev.clientX; oy = ev.clientY;
      positionNode(g, n); draw();
    });
    g.addEventListener('pointerup', (ev) => {
      dragging = false; g.classList.remove('dragging');
      g.releasePointerCapture(ev.pointerId);
      if (!moved && !n.focal) kbOpenGraph(n.id, n.name); // click neighbor → re-center
    });
    g.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && !n.focal) { ev.preventDefault(); kbOpenGraph(n.id, n.name); }
    });
    return g;
  }
  function positionNode(g, n) { g.setAttribute('transform', `translate(${n.x},${n.y})`); }

  draw();
  nodes.forEach((n, i) => nodeLayer.appendChild(nodeEl(n, i)));
  mount.replaceChildren(svg);
  const hint = document.createElement('p');
  hint.className = 'kb-graph-hint muted';
  hint.textContent = 'Drag to rearrange · click a neighbor to expand it';
  mount.appendChild(hint);
}

// ── KB event wiring (delegated) ──────────────────────────────────────
function kbSkeleton(n) {
  return `<div class="kb-skel-wrap">${Array.from({ length: n }, () => '<div class="kb-skel"></div>').join('')}</div>`;
}

$('#kb-refresh')?.addEventListener('click', refreshKb);
$$('.kb-tab').forEach((t) => t.addEventListener('click', () => kbSetTab(t.dataset.kbtab)));

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
  const forget = e.target.closest('.kb-forget'); if (forget) { kbForgetFact(forget.dataset.uid); return; }
  const ent = e.target.closest('[data-entity-id]');
  if (ent) { kbSetTab('entities'); kbSelectEntity(ent.dataset.entityId); }
});

let entitySearchTimer = null;
$('#kb-entity-search')?.addEventListener('input', (e) => {
  kb.entitySearch = e.target.value;
  clearTimeout(entitySearchTimer);
  entitySearchTimer = setTimeout(kbSearchEntities, 220);
});
$('#kb-entity-type')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kbetype]'); if (!b) return;
  kb.entityType = b.dataset.kbetype || null; kbSearchEntities();
});
$('#kb-entity-list')?.addEventListener('click', (e) => {
  const row = e.target.closest('.kb-row'); if (row) kbSelectEntity(row.dataset.entityId);
});
$('#kb-entity-detail')?.addEventListener('click', (e) => {
  const g = e.target.closest('.kb-graph-open');
  if (g) { kbOpenGraph(g.dataset.entityId, g.dataset.name); return; }
  const rel = e.target.closest('.kb-rel-btn');
  if (rel) kbSelectEntity(rel.dataset.entityId);
});

// ════════════════════════════════════════════════════════════════════
// GRAPH VIEW — whole-KB force-directed graph on canvas (Obsidian-style)
// Hand-rolled spring-electrical simulation (velocity Verlet + cooling),
// no dependencies. Facts + entities as nodes; fact→entity mentions and
// entity→entity relations as edges.
// ════════════════════════════════════════════════════════════════════
const graph = {
  loaded: false,
  raw: null,            // { nodes, edges, counts, truncated }
  sim: null,            // running simulation handle
  view: { x: 0, y: 0, k: 1 },  // pan (x,y) + zoom (k)
  hover: null,
  dragNode: null,
  panning: false,
};

// Entity-type palette — a cohesive cool triad, distinct on the near-black
// canvas. Used by both the graph nodes and the KB browser's type dots/legend.
const ENTITY_COLORS = { person: '#4ea1ff', topic: '#9a86ff', document: '#43c9b0' };
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

async function initGraphView() {
  if (graph.loaded) { graph.hover = null; hideTooltip(); graphFit(); return; }
  await loadGraph();
}

async function loadGraph() {
  const overlay = $('#graph-overlay');
  overlay.innerHTML = `<div class="graph-status">Building graph…</div>`;
  overlay.style.display = 'flex';
  try {
    const data = await fetchGraphData();
    graph.raw = data;
    $('#graph-meta').textContent =
      `${data.counts.facts} facts · ${data.counts.entities} entities · ${data.counts.edges} links${data.truncated ? ' (capped)' : ''}`;
    if (!data.nodes.length) {
      overlay.innerHTML = `<div class="graph-status">No memory to graph yet. As your agents store facts, the map fills in.</div>`;
      return;
    }
    overlay.style.display = 'none';
    buildSimulation(data);
    graph.loaded = true;
  } catch (err) {
    overlay.innerHTML = `<div class="graph-status err">Couldn’t build the graph: ${escape(err.message)}</div>`;
  }
}

// Primary: single graphSnapshot RPC. Fallback (older daemons without it):
// compose from listFacts + per-fact getFactContext + searchEntity.
async function fetchGraphData() {
  try {
    return await rpc('graphSnapshot', { limit: 600 });
  } catch (err) {
    // Older daemons don't have graphSnapshot — compose from existing RPCs.
    // Any other error (DB down, etc.) should surface, not silently degrade.
    if (err.code === 'unknown_method') return composeGraphData();
    throw err;
  }
}

async function composeGraphData() {
  const FACT_CAP = 150;
  const [{ facts }, ...entityGroups] = await Promise.all([
    rpc('listFacts', { limit: FACT_CAP }),
    rpc('searchEntity', { entityType: 'person', limit: 200 }).catch(() => ({ entities: [] })),
    rpc('searchEntity', { entityType: 'topic', limit: 200 }).catch(() => ({ entities: [] })),
    rpc('searchEntity', { entityType: 'document', limit: 200 }).catch(() => ({ entities: [] })),
  ]);
  const entityMap = new Map();
  for (const g of entityGroups) for (const e of g.entities) entityMap.set(e.id, e);

  const edges = [];
  const relSeen = new Set();
  const degree = new Map();
  const bump = (k) => degree.set(k, (degree.get(k) || 0) + 1);

  // Fetch each fact's context with bounded concurrency.
  const contexts = await mapLimit(facts, 8, (f) => rpc('getFactContext', { uid: f.uid }).catch(() => null));
  facts.forEach((f, i) => {
    const ctx = contexts[i];
    if (!ctx || ctx.notFound) return;
    for (const e of ctx.entities || []) {
      if (!entityMap.has(e.id)) entityMap.set(e.id, { id: e.id, name: e.name, entityType: e.entityType, mentionCount: 0 });
      const s = `f${f.id}`, t = `e${e.id}`;
      edges.push({ source: s, target: t, kind: 'mentions' }); bump(s); bump(t);
    }
    for (const r of ctx.relations || []) {
      // relations come keyed by names here; skip if we can't resolve to ids cheaply
      const key = `${r.relationType}:${r.sourceName}->${r.targetName}`;
      if (relSeen.has(key)) continue;
      relSeen.add(key);
    }
  });

  const nodes = [
    ...[...entityMap.values()].map((e) => ({
      id: `e${e.id}`, refId: e.id, kind: 'entity', label: e.name,
      entityType: e.entityType || 'topic', mentions: e.mentionCount || 0, degree: degree.get(`e${e.id}`) || 0,
    })),
    ...facts.map((f) => ({
      id: `f${f.id}`, refId: f.id, kind: 'fact', label: (f.content || '').slice(0, 160),
      category: f.category || null, degree: degree.get(`f${f.id}`) || 0,
    })),
  ];
  return { nodes, edges, truncated: facts.length >= FACT_CAP, counts: { facts: facts.length, entities: entityMap.size, edges: edges.length, relations: 0 } };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function buildSimulation(data) {
  const stage = $('#graph-stage');
  const W = stage.clientWidth, H = stage.clientHeight;

  // node radius: entities scale with degree+mentions; facts are small dots
  const nodes = data.nodes.map((n, idx) => {
    const deg = n.degree || 0;
    const r = n.kind === 'entity' ? Math.min(4 + Math.sqrt(deg + (n.mentions || 0)) * 3.2, 22) : 3.2;
    // seed on a spiral so the layout opens consistently (no Math.random reliance for repeatability)
    const ang = idx * 2.399963229, rad = 14 * Math.sqrt(idx);
    return { ...n, r, x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad, vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = data.edges
    .map((e) => ({ ...e, s: byId.get(e.source), t: byId.get(e.target) }))
    .filter((l) => l.s && l.t);

  // adjacency for hover-highlight
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const l of links) { adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id); }

  graph.nodes = nodes; graph.links = links; graph.byId = byId; graph.adj = adj;

  setupCanvas();
  if (graph.sim) cancelAnimationFrame(graph.sim);

  // simulation params
  const REPULSION = 1400, LINK_DIST = 64, LINK_K = 0.04, GRAVITY = 0.018, DAMP = 0.86;
  let alpha = 1;

  function tick() {
    const cx = W / 2, cy = H / 2;
    // repulsion (O(n²) — fine for a few hundred nodes)
    for (let a = 0; a < nodes.length; a++) {
      const na = nodes[a];
      for (let b = a + 1; b < nodes.length; b++) {
        const nb = nodes[b];
        let dx = na.x - nb.x, dy = na.y - nb.y;
        let d2 = dx * dx + dy * dy; if (d2 < 0.01) { d2 = 0.01; dx = (a - b) * 0.1; }
        const f = (REPULSION * alpha) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        na.vx += fx; na.vy += fy; nb.vx -= fx; nb.vy -= fy;
      }
    }
    // springs
    for (const l of links) {
      let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = LINK_K * (d - LINK_DIST) * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy;
    }
    // gravity to center (contains orphans) + integrate
    for (const n of nodes) {
      if (n === graph.dragNode || n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx += (cx - n.x) * GRAVITY * alpha;
      n.vy += (cy - n.y) * GRAVITY * alpha;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
    // forceCenter: snap the free cluster's centroid back to canvas center each
    // tick (Obsidian-style center of gravity) so the layout settles centered
    // instead of drifting off into a corner. Pinned / dragged nodes are excluded
    // so a deliberate placement isn't yanked around.
    let mx = 0, my = 0, cnt = 0;
    for (const n of nodes) { if (n === graph.dragNode || n.pinned) continue; mx += n.x; my += n.y; cnt++; }
    if (cnt) {
      const sx = cx - mx / cnt, sy = cy - my / cnt;
      for (const n of nodes) { if (n === graph.dragNode || n.pinned) continue; n.x += sx; n.y += sy; }
    }
    alpha *= 0.985;
  }

  if (reducedMotion) {
    for (let i = 0; i < 320; i++) tick();
    graphFit(); render();
  } else {
    function loop() {
      tick();
      render();
      if (alpha > 0.02 || graph.dragNode) { graph.sim = requestAnimationFrame(loop); }
      else graph.sim = null;
    }
    graphFit(false);
    graph.sim = requestAnimationFrame(loop);
  }
  graph._reheat = () => { alpha = Math.max(alpha, 0.5); if (!graph.sim && !reducedMotion) graph.sim = requestAnimationFrame(function l() { tick(); render(); if (alpha > 0.02 || graph.dragNode) graph.sim = requestAnimationFrame(l); else graph.sim = null; }); };
}

function setupCanvas() {
  const canvas = $('#graph-canvas');
  const stage = $('#graph-stage');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = stage.clientWidth * dpr;
  canvas.height = stage.clientHeight * dpr;
  canvas.style.width = stage.clientWidth + 'px';
  canvas.style.height = stage.clientHeight + 'px';
  graph.ctx = canvas.getContext('2d');
  graph.dpr = dpr;
}

function render() {
  const ctx = graph.ctx; if (!ctx) return;
  const canvas = $('#graph-canvas');
  const { x: px, y: py, k } = graph.view;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(graph.dpr, graph.dpr);
  ctx.translate(px, py); ctx.scale(k, k);

  const hoverId = graph.hover?.id;
  const lit = hoverId ? graph.adj.get(hoverId) : null;
  const isLit = (id) => !hoverId || id === hoverId || lit.has(id);

  // edges — three tiers: incident-to-hover (bright), idle (legible at rest),
  // non-incident-while-hovering (faded so the focused subgraph reads clearly)
  for (const l of graph.links) {
    const incident = l.s.id === hoverId || l.t.id === hoverId;
    const faded = hoverId && !incident;
    ctx.beginPath();
    ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y);
    if (l.kind === 'relation') {
      ctx.strokeStyle = incident ? 'rgba(0,132,255,0.7)' : faded ? 'rgba(0,132,255,0.06)' : 'rgba(0,132,255,0.3)';
      ctx.lineWidth = 1.3 / k;
    } else {
      ctx.strokeStyle = incident ? 'rgba(164,167,179,0.6)' : faded ? 'rgba(140,142,150,0.05)' : 'rgba(146,149,171,0.2)';
      ctx.lineWidth = 1 / k;
    }
    ctx.stroke();
  }
  // nodes
  for (const n of graph.nodes) {
    const on = isLit(n.id);
    ctx.globalAlpha = on ? 1 : 0.22;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    if (n.kind === 'entity') {
      ctx.fillStyle = ENTITY_COLORS[n.entityType] || ENTITY_COLORS.topic;
      ctx.fill();
      if (n.id === hoverId) { ctx.lineWidth = 2 / k; ctx.strokeStyle = '#f4f5f6'; ctx.stroke(); }
    } else {
      ctx.fillStyle = '#5b5f67'; // visible-but-secondary on the near-black canvas
      ctx.fill();
      if (n.id === hoverId) { ctx.lineWidth = 2 / k; ctx.strokeStyle = '#0084ff'; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    // labels: hubs (high-degree entities) read at any zoom; leaf entities only
    // when zoomed in or hovered; facts only on hover. Keeps dense graphs legible.
    const isHub = n.kind === 'entity' && n.degree >= 2;
    const showLabel = n.id === hoverId || (n.kind === 'entity' && on && (isHub || k > 1.45));
    if (showLabel) {
      const label = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
      ctx.font = `${n.kind === 'entity' ? 600 : 400} ${11 / k}px 'Geist', ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = on ? '#f4f5f6' : '#74777d';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(label, n.x, n.y + n.r + 2 / k);
    }
  }
  ctx.restore();
}

// fit all nodes into view (with padding)
function graphFit(doRender = true) {
  const nodes = graph.nodes; if (!nodes?.length) return;
  const stage = $('#graph-stage');
  const W = stage.clientWidth, H = stage.clientHeight;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
  const pad = 96; // generous margin so edge nodes' labels stay in frame
  // Cap below the leaf-label threshold (1.45) so the default view labels only
  // hubs; zooming in past that reveals every entity label.
  const k = Math.min((W - pad) / gw, (H - pad) / gh, 1.35);
  graph.view.k = k;
  graph.view.x = W / 2 - ((minX + maxX) / 2) * k;
  graph.view.y = H / 2 - ((minY + maxY) / 2) * k;
  if (doRender) render();
}

// screen → world coords
function toWorld(sx, sy) {
  return { x: (sx - graph.view.x) / graph.view.k, y: (sy - graph.view.y) / graph.view.k };
}
function nodeAt(sx, sy) {
  const { x, y } = toWorld(sx, sy);
  // topmost (facts drawn last but entities are bigger targets) — iterate reverse
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const n = graph.nodes[i];
    const dx = n.x - x, dy = n.y - y;
    const hitR = Math.max(n.r, 6); // generous hit target in world units
    if (dx * dx + dy * dy <= hitR * hitR) return n;
  }
  return null;
}

// ── graph interactions ───────────────────────────────────────────────
(function wireGraph() {
  const stage = () => $('#graph-stage');
  const canvas = () => $('#graph-canvas');
  let down = null;

  $('#graph-stage')?.addEventListener('pointerdown', (e) => {
    const rect = canvas().getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const n = nodeAt(sx, sy);
    down = { sx, sy, vx: graph.view.x, vy: graph.view.y, node: n, moved: false };
    if (n) { graph.dragNode = n; } else { graph.panning = true; }
    canvas().setPointerCapture(e.pointerId);
  });
  $('#graph-stage')?.addEventListener('pointermove', (e) => {
    const rect = canvas().getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (!down) {
      const n = nodeAt(sx, sy);
      if (n !== graph.hover) { graph.hover = n; showTooltip(n, sx, sy); render(); }
      else if (n) showTooltip(n, sx, sy);
      canvas().style.cursor = n ? 'pointer' : 'grab';
      return;
    }
    const ddx = sx - down.sx, ddy = sy - down.sy;
    if (Math.abs(ddx) > 3 || Math.abs(ddy) > 3) down.moved = true;
    if (down.node) {
      const w = toWorld(sx, sy);
      down.node.x = w.x; down.node.y = w.y;
      graph._reheat?.(); render();
    } else if (graph.panning) {
      graph.view.x = down.vx + ddx; graph.view.y = down.vy + ddy;
      render();
    }
  });
  function endDrag(_e) {
    if (down && down.node && !down.moved) openGraphNode(down.node);
    else if (down && down.node && down.moved) down.node.pinned = true; // keep a deliberately-placed node put
    graph.dragNode = null; graph.panning = false; down = null;
    if (canvas()) canvas().style.cursor = 'grab';
  }
  $('#graph-stage')?.addEventListener('pointerup', endDrag);
  $('#graph-stage')?.addEventListener('pointerleave', () => { if (!down) { graph.hover = null; hideTooltip(); render(); } });

  $('#graph-stage')?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas().getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k0 = graph.view.k, k1 = Math.max(0.15, Math.min(k0 * factor, 6));
    // zoom toward cursor
    graph.view.x = sx - (sx - graph.view.x) * (k1 / k0);
    graph.view.y = sy - (sy - graph.view.y) * (k1 / k0);
    graph.view.k = k1;
    render();
  }, { passive: false });

  $('#graph-zoom-in')?.addEventListener('click', () => zoomBy(1.25));
  $('#graph-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.25));
  $('#graph-zoom-fit')?.addEventListener('click', () => graphFit());
  $('#graph-refresh')?.addEventListener('click', () => { graph.loaded = false; loadGraph(); });
  $('#graph-relayout')?.addEventListener('click', () => { if (graph.raw) buildSimulation(graph.raw); });

  function zoomBy(f) {
    const stageEl = stage(); const sx = stageEl.clientWidth / 2, sy = stageEl.clientHeight / 2;
    const k0 = graph.view.k, k1 = Math.max(0.15, Math.min(k0 * f, 6));
    graph.view.x = sx - (sx - graph.view.x) * (k1 / k0);
    graph.view.y = sy - (sy - graph.view.y) * (k1 / k0);
    graph.view.k = k1; render();
  }
})();

function showTooltip(n, sx, sy) {
  const tip = $('#graph-tooltip');
  if (!n) { hideTooltip(); return; }
  tip.hidden = false;
  tip.innerHTML = n.kind === 'entity'
    ? `<span class="gt-kind">${escape(titleCase(n.entityType))}</span>${escape(n.label)}<span class="gt-meta">${n.mentions} mentions · ${n.degree} links</span>`
    : `<span class="gt-kind">Fact</span>${escape(n.label)}`;
  const stage = $('#graph-stage');
  const tw = tip.offsetWidth || 220, th = tip.offsetHeight || 64;
  tip.style.left = Math.max(4, Math.min(sx + 14, stage.clientWidth - tw - 4)) + 'px';
  tip.style.top = Math.max(4, Math.min(sy + 14, stage.clientHeight - th - 4)) + 'px';
}
function hideTooltip() { const t = $('#graph-tooltip'); if (t) t.hidden = true; }

function openGraphNode(n) {
  setRoute('kb');
  if (n.kind === 'entity') { kbSetTab('entities'); kbSelectEntity(n.refId); }
  else {
    kbSetTab('facts');
    // ensure facts are loaded, then select the row
    if (kb.facts.length) kbSelectFactById(n.refId);
    else kbLoadFacts().then(() => kbSelectFactById(n.refId));
  }
}
function kbSelectFactById(factId) {
  const f = kb.facts.find((x) => x.refId === factId || x.id === factId);
  if (f) kbSelectFact(f.uid);
  else rpc('getFactContext', { factId }).then((ctx) => {
    if (ctx?.fact?.uid) kbSelectFact(ctx.fact.uid);
  }).catch(() => {});
}

let _graphResizeT = null;
window.addEventListener('resize', () => {
  if (location.hash !== '#graph' || !graph.loaded) return;
  clearTimeout(_graphResizeT);
  _graphResizeT = setTimeout(() => { setupCanvas(); graphFit(); }, 150);
});

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
  // Config summary from the config store (config.json), secrets masked.
  try {
    const c = await rpc('setup.config', {});
    const db = c.database || {};
    const dbDesc = db.mode === 'url' ? `connection URL (${db.urlHost || '—'})`
      : db.mode === 'docker' ? `Docker container (localhost:${db.port})`
      : db.mode === 'local' ? `local Postgres (${db.host}:${db.port})`
      : 'not configured';
    $('#cfg-db').textContent = `${dbDesc}${c.setup?.steps?.database === 'done' ? ' · ready' : ''}`;
    $('#cfg-llm').textContent = c.llm?.provider ? `${c.llm.provider}${c.llm.model ? ` · ${c.llm.model}` : ''}` : 'not configured';
    $('#cfg-emb').textContent = c.embedding?.provider
      ? `${c.embedding.provider} · ${c.embedding.model} · ${c.embedding.dim}d`
      : 'not configured';
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
        ['Name', c.identity?.name || '—'],
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
async function refreshSettingsClients() {
  const host = $('#settings-connectors');
  if (!host) return;
  try {
    const { connectors } = await rpc('listConnectors');
    host.innerHTML = '';
    if (!connectors.length) {
      host.innerHTML = '<div class="muted">no agents registered</div>';
      return;
    }
    connectors.forEach((c) => host.appendChild(connectorCard(c, onSettingsClientAction)));
  } catch (err) {
    host.innerHTML = `<div class="muted">could not load agents: ${escape(err.message)}</div>`;
  }
}

async function onSettingsClientAction(id, action) {
  const host = $('#settings-connectors');
  const card = host?.querySelector(`[data-id="${id}"]`);
  if (action === 'disconnect') {
    try {
      await rpc('disconnectConnector', { id });
      toast({ variant: 'success', message: `${id} disconnected` });
    } catch (err) { toast({ variant: 'error', message: err.message, hint: err.hint, code: err.code }); }
    return refreshSettingsClients();
  }
  if (card) card.replaceWith(connectorCard({ id, label: id, hint: '', uiState: 'connecting' }, onSettingsClientAction));
  try {
    await rpc('connectConnector', { id });
    toast({ variant: 'success', message: `${id} connected` });
  } catch (err) {
    toast({ variant: 'error', message: err.message || `could not connect ${id}`, hint: err.hint, code: err.code });
  }
  return refreshSettingsClients();
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
    restartAndClose(out);
  } catch (err) {
    out.classList.add('err'); out.textContent = `✗ ${err.message}`;
  }
});

// ── Settings: danger zone — factory reset ────────────────────────────
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
      const r = await rpc('setup.factoryReset', { wipeMemory });
      toast({ variant: 'success', message: `Reset complete — disconnected ${r.disconnected?.length || 0} agent(s)${wipeMemory ? `, wiped ${r.tablesWiped || 0} tables` : ''}.` });
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      host.innerHTML = `<div class="result err" style="margin:0;">✗ ${escape(err.message)}</div>`;
    }
  });
});

async function restartAndClose(out) {
  out.textContent += '\nApplying — restarting daemon…';
  try { await rpc('restartDaemon', {}); } catch { /* expected: connection drops on exit */ }
  setTimeout(() => { $('#cfg-switch').style.display = 'none'; refreshEnv(); refreshHealth(); }, 1500);
}

// ── Activity / causal trace log ──────────────────────────────────────
let ws = null;
let traceFilter = '';
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
    prependTrace(evt, true);
  } else if (!traceFilter) {
    // operational events (rpc/pair/device) only shown in the unfiltered view
    prependOpEvent(evt);
  }
}

async function loadTraces() {
  const list = $('#trace-list');
  if (!list) return;
  try {
    const { traces } = await rpc('trace.list', { kind: traceFilter || undefined, limit: 50 });
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
  li.innerHTML = `
    <button class="trace-head" type="button" aria-expanded="false">
      <span class="trace-caret">▸</span>
      <span class="trace-ts">${escape(clock(t.ts))}</span>
      <span class="badge ${traceBadge(t.kind)}">${escape(t.kind)}</span>
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
  if (t.kind === 'search') return renderSearchTrace(d);
  if (t.kind === 'ingest') return renderIngestTrace(d);
  return `<pre class="trace-json">${escape(JSON.stringify(d, null, 2))}</pre>`;
}

const sc = (v) => (v === null || v === undefined ? '—' : String(v));

function renderSearchTrace(d) {
  const parts = [];

  if (d.routing) {
    const r = d.routing;
    parts.push(traceBlock('Routing', `
      ${kvline('intent', r.intent)}
      ${kvline('reasoning', r.reasoning)}
      ${kvline('useGraph', r.useGraph)} ${kvline('expand', r.expand)} ${kvline('limit', r.limit)}
      ${r.categories && r.categories.length ? kvline('categories', r.categories.join(', ')) : ''}
      ${r.pointInTime ? kvline('pointInTime', r.pointInTime) : ''}`));
  } else {
    parts.push(traceBlock('Routing', `<span class="muted">cognitive routing disabled for this query</span>`));
  }

  parts.push(traceBlock('Strategy', `${kvline('mode', d.strategy)} ${d.matchedEntity
    ? `· matched entity <strong>${escape(d.matchedEntity.name)}</strong> <span class="muted">(${escape(d.matchedEntity.type)}${d.matchedEntity.aliases?.length ? ', aliases: ' + escape(d.matchedEntity.aliases.join(', ')) : ''})</span>`
    : ''}`));

  const facts = (d.ranking && d.ranking.facts) || [];
  if (facts.length) {
    const rows = facts.map((f) => `<tr>
        <td class="num">${f.rank}</td>
        <td class="fact-cell">${escape(f.content)}${f.source ? ` <span class="tag">${escape(f.source)}</span>` : ''}${f.importance === 'vital' ? ' <span class="tag vital">vital</span>' : ''}</td>
        <td class="num" title="cosine similarity">${sc(f.similarity)}</td>
        <td class="num" title="RRF fusion (vector+keyword)">${sc(f.rrfRaw)}</td>
        <td class="num" title="ACT-R activation = ln(uses+1) − 0.5·ln(age_days); recency + frequency decay">${sc(f.activation)}</td>
        <td class="num" title="access count (reinforcement)">${sc(f.accessCount)}</td>
        <td class="num" title="rrf × activation × importance × confidence">${sc(f.finalScore)}</td>
        <td class="num strong" title="normalized score the ranker sorted on">${sc(f.rrfScore)}</td>
      </tr>`).join('');
    parts.push(`<div class="trace-block"><div class="trace-block-h">Ranking <span class="muted">— ${escape(d.ranking.model)}</span></div>
      <div class="trace-table-wrap"><table class="trace-table">
        <thead><tr><th>#</th><th>fact</th><th>sim</th><th>rrf</th><th>act↓</th><th>uses</th><th>final</th><th>score</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`);
  } else {
    parts.push(traceBlock('Ranking', `<span class="muted">no facts matched</span>`));
  }

  const chunks = (d.ranking && d.ranking.chunks) || [];
  if (chunks.length) {
    const rows = chunks.map((c) => `<tr>
        <td class="num">${c.rank}</td>
        <td class="fact-cell">${c.sectionHeading ? `<span class="muted">${escape(c.sectionHeading)} · </span>` : ''}${escape(c.content)}</td>
        <td class="num">${sc(c.similarity)}</td>
        <td class="num strong">${sc(c.rrfScore)}</td>
      </tr>`).join('');
    parts.push(`<div class="trace-block"><div class="trace-block-h">Chunks</div>
      <div class="trace-table-wrap"><table class="trace-table">
        <thead><tr><th>#</th><th>chunk</th><th>sim</th><th>score</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`);
  }

  if (d.synthesized) parts.push(traceBlock('Synthesized answer', `<div class="synth">${escape(d.synthesized)}</div>`));

  if (d.reinforced && d.reinforced.factIds && d.reinforced.factIds.length) {
    parts.push(traceBlock('Reinforcement (decay update)', `<span class="muted">${escape(d.reinforced.note)}</span><br>fact ids: <code class="mono">${escape(d.reinforced.factIds.join(', '))}</code>`));
  }

  return parts.join('');
}

function renderIngestTrace(d) {
  const parts = [];
  const inputs = d.inputs || (d.verdicts ? [{ input: d.title, route: d.route, counts: d.counts, verdicts: d.verdicts, entities: d.entities }] : []);

  if (d.totals) parts.push(traceBlock('Totals', `${kvline('added', d.totals.added)} ${kvline('updated', d.totals.updated)} ${kvline('alreadyKnown', d.totals.alreadyKnown)} ${kvline('inputs', d.totals.inputCount)}`));

  inputs.forEach((inp, i) => {
    const verdictRows = (inp.verdicts || []).map((v) => {
      const a = v.audm || {};
      const simTxt = a.topSimilarity != null
        ? `sim <strong>${a.topSimilarity.toFixed(3)}</strong> ${audmExplain(a)}`
        : `<span class="muted">${escape(a.decision || 'no match — new fact')}</span>`;
      const link = v.supersededId ? ` → superseded #${v.supersededId}` : v.contradictedId ? ` → contradicted #${v.contradictedId}` : '';
      return `<tr>
        <td><span class="badge ${audmBadge(v.action)}">${escape(v.action)}</span></td>
        <td class="fact-cell">${escape(v.content)}${link ? `<span class="muted">${escape(link)}</span>` : ''}</td>
        <td class="audm-cell">${simTxt}</td>
      </tr>`;
    }).join('');

    const head = `${inp.route ? `<span class="badge info">route: ${escape(inp.route)}</span> ` : ''}${inp.skipped ? '<span class="badge warn">skipped</span> ' : ''}<span class="muted">${escape(String(inp.input || '').slice(0, 160))}</span>`;
    const counts = inp.counts ? `<div class="muted text-xs" style="margin:6px 0">+${inp.counts.added} added · ~${inp.counts.updated} updated · ${inp.counts.skipped} skipped · ${inp.counts.contradicted} contradicted</div>` : '';
    const ents = inp.entities ? `<div class="text-xs muted" style="margin-top:6px">entities: ${inp.entities.entityCount}, relations: ${inp.entities.relationCount}${inp.entities.topics?.length ? ' · topics: ' + escape(inp.entities.topics.join(', ')) : ''}</div>` : '';

    parts.push(`<div class="trace-block">
      <div class="trace-block-h">Input ${inputs.length > 1 ? i + 1 : ''}</div>
      <div style="margin-bottom:6px">${head}</div>
      ${counts}
      ${verdictRows ? `<div class="trace-table-wrap"><table class="trace-table"><thead><tr><th>AUDM</th><th>fact</th><th>decision</th></tr></thead><tbody>${verdictRows}</tbody></table></div>` : '<span class="muted text-xs">no facts extracted</span>'}
      ${ents}
    </div>`);
  });

  return parts.join('') || `<pre class="trace-json">${escape(JSON.stringify(d, null, 2))}</pre>`;
}

function audmExplain(a) {
  const th = a.thresholds || {};
  if (a.decision === 'skip-duplicate') return `≥ skip ${th.skip} → near-duplicate, deduped`;
  if (a.decision === 'llm:UPDATE') return `in [${th.ambiguous}, ${th.skip}) → LLM judged UPDATE`;
  if (a.decision === 'llm:CONTRADICT') return `in [${th.ambiguous}, ${th.skip}) → LLM judged CONTRADICT`;
  if (a.decision === 'llm:ADD') return `in [${th.ambiguous}, ${th.skip}) → LLM judged distinct`;
  if (a.decision === 'below-ambiguous') return `< ambiguous ${th.ambiguous} → distinct, added`;
  return escape(a.decision || '');
}

function traceBlock(title, html) { return `<div class="trace-block"><div class="trace-block-h">${escape(title)}</div><div>${html}</div></div>`; }
function kvline(k, v) { return `<span class="kvline"><span class="muted">${escape(k)}</span> ${escape(sc(v))}</span>`; }
function clock(iso) { return (iso || '').slice(11, 19) || (iso || '').slice(0, 10); }

function traceBadge(kind) {
  if (kind === 'search') return 'info';
  if (kind === 'ingest') return 'ok';
  if (kind === 'lifecycle') return 'warn';
  return 'info';
}
function audmBadge(action) {
  const a = String(action || '').toUpperCase();
  if (a === 'ADD') return 'ok';
  if (a === 'SKIP') return '';
  if (a === 'UPDATE') return 'info';
  if (a === 'CONTRADICT') return 'err';
  return 'info';
}
function opBadge(type) {
  if (type.startsWith('write.')) return 'ok';
  if (type.startsWith('error') || type.startsWith('pair.rej')) return 'err';
  if (type.startsWith('device.rev') || type === 'meta.dropped') return 'warn';
  return 'info';
}
function opSummary(evt) {
  if (evt.type === 'rpc.connected')    return `device ${escape(evt.name || evt.deviceId)} connected`;
  if (evt.type === 'rpc.disconnected') return `device ${escape(evt.deviceId)} disconnected`;
  if (evt.type === 'rpc.denied')       return `denied ${escape(evt.method)} (${escape(evt.code)})`;
  if (evt.type === 'pair.consumed')    return `paired ${escape(evt.deviceName)}`;
  if (evt.type === 'pair.rejected')    return `pairing rejected (${escape(evt.code)})`;
  if (evt.type === 'device.revoked')   return `device ${escape(evt.deviceId)} revoked (${escape(evt.reason)})`;
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
$('#trace-refresh')?.addEventListener('click', loadTraces);
$('#trace-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear the entire trace log? This deletes persisted history.')) return;
  try { await rpc('trace.clear'); } catch {}
  loadTraces();
});

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
  if (a) rpc('device.activate', { id: Number(a.dataset.activate) }).then(refreshDevices).catch((err) => toast({ variant: 'error', message: err.message }));
  const cb = e.target.closest('[data-revoke-code]');
  if (cb) rpc('pair.revoke', { id: Number(cb.dataset.revokeCode) }).then(refreshDevices).catch((err) => toast({ variant: 'error', message: err.message }));
});

$('#revoke-confirm')?.addEventListener('click', async () => {
  if (revokeTargetId == null) return;
  const reason = $('input[name="revoke-reason"]:checked').value;
  try { await rpc('device.revoke', { id: revokeTargetId, reason }); closeModal('revoke-modal'); refreshDevices(); }
  catch (err) { toast({ variant: 'error', message: err.message }); }
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
  const name = $('#dev-name').value.trim(); if (!name) { toast({ variant: 'error', message: 'Device name is required.' }); return; }
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
  } catch (err) { toast({ variant: 'error', message: err.message || 'Create pairing code failed.' }); }
});

// ════════════════════════════════════════════════════════════════════
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
runLanding();
setInterval(() => { if (!document.hidden) refreshHealth(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshHealth(); });
