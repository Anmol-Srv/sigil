/**
 * ⌘K — the one bar that does everything. See DESIGN.md › Global ⌘K.
 *
 * Two implicit modes, no tabs:
 *   Act    — remember a fact, add a device, connect a tool
 *   Recall — anything typed also runs a live hybrid memory search
 *
 * Navigation deliberately lives in the sidebar only: it is always visible and
 * one click away, so listing every page here just pushed the recall results —
 * the thing the bar exists for — below the fold.
 *
 * The search half matters most: recall is the product, and until now the
 * dashboard was the only Sigil surface that couldn't run one. Results open the
 * fact in the Knowledge Base with its provenance, so "why did my agent get
 * this?" is two keystrokes from anywhere.
 *
 * Built on native <dialog>: focus trap, backdrop, and Escape come free.
 */
import { icon } from './icons.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Simple subsequence match — "rem" hits "Remember a fact", "dev" hits "Add a device".
export function fuzzy(needle, hay) {
  const n = needle.toLowerCase(), h = hay.toLowerCase();
  if (!n) return true;
  let i = 0;
  for (const ch of h) if (ch === n[i] && ++i === n.length) return true;
  return false;
}

export function initCmdk({ rpc, setRoute, openFact, toast, onRemembered, onIngest }) {
  const dlg   = document.getElementById('cmdk');
  const input = document.getElementById('cmdk-input');
  const list  = document.getElementById('cmdk-list');
  const foot  = document.getElementById('cmdk-mode');
  if (!dlg || !input || !list) return {};

  let mode = 'command';   // 'command' | 'compose'
  let items = [];         // flat, in render order — what ↑/↓/↵ act on
  let cursor = 0;
  let hits = [];          // latest memory-search results
  let searchSeq = 0;      // guards against out-of-order search responses
  let timer = null;

  const ACTIONS = [
    { id: 'remember', label: 'Remember a fact…', icon: 'plus', hint: 'save a short statement to memory',
      run: () => enterCompose() },
    { id: 'ingest', label: 'Ingest a document…', icon: 'doc', hint: 'store a file whole — spec, notes, transcript',
      run: () => { close(); onIngest?.(); } },
    { id: 'device', label: 'Add a device', icon: 'monitor', hint: 'create a pairing code',
      run: () => { close(); setRoute('devices'); document.getElementById('dev-new')?.click(); } },
    { id: 'agents', label: 'Connect a coding tool', icon: 'terminal', hint: 'Claude Code · Codex · Cursor · Kiro',
      run: () => { close(); setRoute('agents'); } },
    { id: 'llm', label: 'Change LLM provider', icon: 'sliders', hint: 'switch model or key',
      run: () => { close(); setRoute('settings'); document.getElementById('cfg-change-llm')?.click(); } },
  ];

  // ── rendering ──────────────────────────────────────────────────────
  function row(it, i) {
    const on = i === cursor;
    return `<li class="cmdk-row${on ? ' on' : ''}" id="cmdk-o${i}" role="option" aria-selected="${on}" data-i="${i}">
      <span class="cmdk-ic">${icon(it.icon || 'arrow')}</span>
      <span class="cmdk-label">${esc(it.label)}</span>
      ${it.hint ? `<span class="cmdk-hint">${esc(it.hint)}</span>` : ''}
      ${it.meta ? `<span class="cmdk-meta">${esc(it.meta)}</span>` : ''}
    </li>`;
  }

  function render() {
    if (mode === 'compose') {
      list.innerHTML = `<li class="cmdk-note">${icon('zap')}<span>A fact is one short, self-contained statement — it has to make sense on its own. Press <kbd>↵</kbd> to save, <kbd>esc</kbd> to go back.</span></li>`;
      return;
    }
    const q = input.value.trim();
    const acts = ACTIONS.filter((a) => fuzzy(q, a.label));
    const mem = hits.map((f) => ({
      label: f.content, icon: 'zap',
      // Provenance over score: "which agent wrote this" is the question the
      // ranker number can't answer, and it's the reason someone opens a fact.
      hint: f.agent || null,
      meta: f.rrfScore != null ? Number(f.rrfScore).toFixed(2) : null,
      run: () => { close(); openFact(f.uid); },
    }));

    items = [...acts, ...mem];
    if (cursor >= items.length) cursor = Math.max(0, items.length - 1);

    let html = '';
    let i = 0;
    const group = (title, arr) => {
      if (!arr.length) return;
      html += `<li class="cmdk-group" role="presentation">${esc(title)}</li>`;
      for (const it of arr) html += row(it, i++);
    };
    group('Actions', acts);
    group(q ? `Memory · “${q}”` : 'Memory', mem);

    if (!items.length) {
      html = q
        ? `<li class="cmdk-note">No action or stored fact matches <strong>${esc(q)}</strong>.</li>`
        : `<li class="cmdk-note">Type to search memory, or run a command.</li>`;
    }
    list.innerHTML = html;
    input.setAttribute('aria-activedescendant', items.length ? `cmdk-o${cursor}` : '');
    list.querySelector('.cmdk-row.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ── live recall ────────────────────────────────────────────────────
  // podScope 'global' on purpose: the dashboard has no cwd to scope to, so
  // "search my memory" here has to mean the whole brain, not a guessed project.
  async function runSearch(q) {
    const seq = ++searchSeq;
    if (!q) { hits = []; setFoot(''); render(); return; }
    setFoot('searching…');
    try {
      const res = await rpc('search', { query: q, limit: 6, podScope: 'global' });
      if (seq !== searchSeq) return;   // a newer keystroke already won
      hits = res.facts || [];
      setFoot(hits.length ? `${hits.length} fact${hits.length === 1 ? '' : 's'} recalled` : 'no facts matched');
    } catch (err) {
      if (seq !== searchSeq) return;
      hits = [];
      setFoot(err.message || 'search failed');
    }
    render();
  }
  const setFoot = (t) => { if (foot) foot.textContent = t; };

  // ── compose (remember) ─────────────────────────────────────────────
  function enterCompose() {
    mode = 'compose';
    dlg.classList.add('composing');
    input.value = '';
    input.placeholder = 'A short, self-contained fact…';
    hits = []; setFoot('saves to your memory on this machine');
    render();
    input.focus();
  }
  function exitCompose() {
    mode = 'command';
    dlg.classList.remove('composing');
    input.value = '';
    input.placeholder = 'Search memory or run a command…';
    setFoot('');
    render();
  }
  async function saveFact() {
    const text = input.value.trim();
    if (!text) return;

    // Close FIRST. `remember` runs the whole ingest pipeline — classification,
    // embedding, AUDM dedup — and on a local claude-cli provider that round
    // trip is routinely a minute or more. Awaiting it before closing left the
    // bar sitting on "saving…" long enough to look hung, over a write that had
    // already been accepted. Your typing is done; the outcome arrives as a
    // toast, which is how every other slow action in the dashboard reports.
    close();
    const dismiss = toast({
      variant: 'info',
      message: 'Saving fact…',
      hint: 'Extraction runs in the background; this can take a moment.',
      timeout: 0,
    });

    try {
      const r = await rpc('remember', { facts: [text] });
      dismiss();
      const n = r?.added ?? 0;
      toast({
        variant: n ? 'success' : 'info',
        message: n ? 'Fact remembered.' : 'Already known — nothing added.',
        hint: r?.updated ? `${r.updated} existing fact updated.` : undefined,
      });
      onRemembered?.();
    } catch (err) {
      dismiss();
      toast({
        variant: 'error',
        message: `Couldn’t save that fact: ${err.message}`,
        hint: err.hint,
        code: err.code,
      });
    }
  }

  // ── open / close ───────────────────────────────────────────────────
  function open() {
    if (dlg.open) return;
    exitCompose();
    cursor = 0;
    dlg.showModal();
    input.focus();
  }
  function close() { if (dlg.open) dlg.close(); }

  // ── wiring ─────────────────────────────────────────────────────────
  input.addEventListener('input', () => {
    if (mode === 'compose') return;
    cursor = 0;
    render();
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(() => runSearch(q), 220);
  });

  input.addEventListener('keydown', (e) => {
    if (mode === 'compose') {
      if (e.key === 'Enter') { e.preventDefault(); saveFact(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exitCompose(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { cursor = (cursor + 1) % items.length; render(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { cursor = (cursor - 1 + items.length) % items.length; render(); } }
    else if (e.key === 'Enter') { e.preventDefault(); items[cursor]?.run(); }
  });

  list.addEventListener('click', (e) => {
    const r = e.target.closest('.cmdk-row');
    if (r) items[Number(r.dataset.i)]?.run();
  });
  list.addEventListener('mousemove', (e) => {
    const r = e.target.closest('.cmdk-row');
    if (r && Number(r.dataset.i) !== cursor) { cursor = Number(r.dataset.i); render(); }
  });

  // Click the backdrop (the dialog element itself, outside its panel) to close.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('close', () => { hits = []; clearTimeout(timer); });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dlg.open ? close() : open(); }
  });
  document.getElementById('cmdk-trigger')?.addEventListener('click', open);

  return { open, close, compose: () => { open(); enterCompose(); } };
}
