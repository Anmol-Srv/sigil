/**
 * Settings — rendered from the daemon's schema, not hand-written.
 *
 * Every control is generated from `settings.schema`, so a knob added to
 * settings-schema.js shows up with no dashboard change and the page can never
 * offer something the daemon won't honour.
 *
 * The shape is deliberate. Forty-five controls in one scroll is the drift
 * DESIGN.md warns about — the rest of the dashboard reveals one section at a
 * time — so there are two levels: a General/Advanced tier, then categories as a
 * segmented sub-nav, the same control the Knowledge Base uses for
 * facts/entities/documents/pods. General is eight settings someone might
 * actually change; Advanced holds the thirty-seven that alter retrieval and
 * ranking. Search cuts across both, for when you know the name but not where
 * it lives.
 *
 * Controls are chosen by what the value IS, not by its JS type. A similarity
 * threshold is a position in a range, so it gets a slider you can feel plus a
 * number you can type; a port is an arbitrary integer, so it stays a field. A
 * boolean is a state you flip, so it gets a switch rather than a checkbox
 * borrowed from a form.
 */
import { icon } from './icons.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORY_ICON = {
  identity: 'home', ingest: 'plus', memory: 'layers', search: 'search',
  engine: 'cpu', hebbian: 'graph', server: 'monitor', output: 'doc',
};

/**
 * A slider only helps when the range has a graspable number of stops. 0–1 by
 * 0.01 is a feel you can drag; a port across 64,511 values is a number you
 * type, and pretending otherwise makes it unusable.
 */
const SLIDER_MAX_STOPS = 200;
function isSliderish(d) {
  if (d.type !== 'number' || d.min == null || d.max == null) return false;
  const step = d.step || 1;
  const stops = (d.max - d.min) / step;
  return stops > 1 && stops <= SLIDER_MAX_STOPS;
}

const fieldId = (path) => `set-${path.replace(/\./g, '-')}`;

function control(d) {
  const id = fieldId(d.path);
  const common = `id="${id}" data-path="${esc(d.path)}" data-type="${d.type}"`;

  if (d.type === 'boolean') {
    return `<button type="button" role="switch" class="set-switch" ${common}
      aria-checked="${d.value ? 'true' : 'false'}" aria-labelledby="${id}-label">
      <span class="set-switch-track"><span class="set-switch-thumb"></span></span>
    </button>`;
  }

  if (d.type === 'enum') {
    // A handful of named options is a segmented control, not a dropdown you
    // have to open to discover what the choices even are.
    return `<div class="set-segmented" role="radiogroup" ${common} aria-labelledby="${id}-label">
      ${d.options.map((o) => `<button type="button" role="radio" class="set-seg${o === d.value ? ' on' : ''}"
        aria-checked="${o === d.value}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}
    </div>`;
  }

  if (isSliderish(d)) {
    return `<div class="set-range">
      <input type="range" ${common} value="${esc(d.value ?? d.min)}"
        min="${d.min}" max="${d.max}" step="${d.step ?? 1}" aria-labelledby="${id}-label">
      <output class="set-range-out" for="${id}">${esc(d.value ?? d.min)}</output>
    </div>`;
  }

  if (d.type === 'number') {
    return `<input class="input set-input" type="number" ${common} value="${esc(d.value ?? '')}"
      ${d.min != null ? `min="${d.min}"` : ''} ${d.max != null ? `max="${d.max}"` : ''}
      ${d.step != null ? `step="${d.step}"` : ''} aria-labelledby="${id}-label">`;
  }

  return `<input class="input set-input" type="text" ${common} value="${esc(d.value ?? '')}"
    placeholder="${esc(d.placeholder || '')}" autocomplete="off" spellcheck="false" aria-labelledby="${id}-label">`;
}

function row(d) {
  const id = fieldId(d.path);
  return `<div class="set-row" data-row="${esc(d.path)}" data-search="${esc((d.label + ' ' + (d.help || '') + ' ' + d.path).toLowerCase())}">
    <div class="set-row-text">
      <span class="set-row-label" id="${id}-label">${esc(d.label)}${d.restart ? '<span class="set-restart" title="Read only at daemon boot">restart</span>' : ''}</span>
      ${d.help ? `<p class="set-row-help">${esc(d.help)}</p>` : ''}
      <div class="set-row-error" data-error-for="${esc(d.path)}"></div>
    </div>
    <div class="set-row-control">${control(d)}</div>
  </div>`;
}

export function initSettings({ rpc, toast, mount }) {
  const host = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!host) return { refresh: () => {} };

  let schema = null;
  let tier = 'general';
  let active = null;
  let query = '';

  const flat = () => schema.flat;
  const el = (sel) => host.querySelector(sel);

  const valueOf = (node) => {
    const t = node.dataset.type;
    if (t === 'boolean') return node.getAttribute('aria-checked') === 'true';
    if (t === 'enum') return node.querySelector('.set-seg.on')?.dataset.value ?? '';
    if (t === 'number') return node.value === '' ? '' : Number(node.value);
    return node.value;
  };

  function dirty() {
    const out = {};
    for (const node of host.querySelectorAll('[data-path]')) {
      const def = flat().get(node.dataset.path);
      if (!def) continue;
      const now = valueOf(node);
      const was = def.value ?? (def.type === 'boolean' ? false : '');
      if (String(now) !== String(was)) out[node.dataset.path] = now;
    }
    return out;
  }

  function syncBar() {
    const n = Object.keys(dirty()).length;
    const bar = el('.set-bar');
    if (!bar) return;
    bar.classList.toggle('on', n > 0);
    const count = el('.set-bar-count');
    if (count) count.textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : '';
  }

  function visibleCount(section) {
    if (!query) return section.settings.length;
    return section.settings.filter((d) => (`${d.label} ${d.help || ''} ${d.path}`).toLowerCase().includes(query)).length;
  }

  function render() {
    // Follow the hits. Searching while sitting on a category with no matches
    // used to render "no setting matches" even though the term hit three rows
    // one tab over — the search says something exists and the body denies it.
    if (query) {
      const here = schema.sections.find((s) => s.id === active);
      if (!here || !visibleCount(here)) {
        const hit = schema.sections.find((s) => visibleCount(s) > 0);
        if (hit) { tier = hit.tier || 'advanced'; active = hit.id; }
      }
    }

    const sections = schema.sections.filter((s) => (s.tier || 'advanced') === tier);
    if (!sections.some((s) => s.id === active)) active = sections[0]?.id ?? null;

    const tierNav = schema.tiers.map((t) => {
      const hits = query
        ? schema.sections.filter((s) => (s.tier || 'advanced') === t.id).reduce((n, s) => n + visibleCount(s), 0)
        : 0;
      return `<button class="set-tier${t.id === tier ? ' on' : ''}" type="button" data-tier="${esc(t.id)}"
        aria-pressed="${t.id === tier}">${esc(t.label)}${query ? `<span class="subtab-count">${hits}</span>` : ''}</button>`;
    }).join('');

    const tabs = sections.map((s) => {
      const n = visibleCount(s);
      const dim = query && !n ? ' dim' : '';
      return `<button class="subtab${s.id === active ? ' active' : ''}${dim}" type="button" role="tab"
        aria-selected="${s.id === active}" data-cat="${esc(s.id)}">
        ${icon(CATEGORY_ICON[s.id] || 'sliders')}<span>${esc(s.title)}</span>
        ${query ? `<span class="subtab-count">${n}</span>` : ''}
      </button>`;
    }).join('');

    const s = sections.find((x) => x.id === active) || sections[0];
    const rows = s.settings
      .filter((d) => !query || (`${d.label} ${d.help || ''} ${d.path}`).toLowerCase().includes(query))
      .map(row).join('');

    const tierMeta = schema.tiers.find((t) => t.id === tier);
    host.innerHTML = `
      <div class="set-toolbar">
        <div class="set-tiers" role="group" aria-label="Settings level">${tierNav}</div>
        <label class="set-search">
          ${icon('search')}
          <input type="search" placeholder="Search all settings…" aria-label="Search settings" value="${esc(query)}" autocomplete="off">
        </label>
      </div>
      ${tierMeta?.help ? `<p class="set-tier-help">${esc(tierMeta.help)}</p>` : ''}
      <div class="subnav" role="tablist" aria-label="Settings categories">${tabs}</div>
      <div class="set-body">
        ${s.help ? `<p class="set-intro">${esc(s.help)}</p>` : ''}
        ${rows || `<div class="empty">No setting matches “${esc(query)}”. Try a different word, or clear the search.</div>`}
      </div>
      <div class="set-bar" role="status">
        <span class="set-bar-count"></span>
        <button class="btn" type="button" data-act="revert">Revert</button>
        <button class="btn primary" type="button" data-act="save">Save changes</button>
      </div>`;
    syncBar();
  }

  async function load() {
    host.innerHTML = '<div class="empty">Loading settings…</div>';
    try {
      const { sections, tiers } = await rpc('settings.schema');
      schema = {
        sections,
        // Fall back rather than crash if an older daemon has no tiers: the
        // page still works as a flat category list.
        tiers: tiers?.length ? tiers : [{ id: 'advanced', label: 'All settings', help: null }],
        flat: new Map(sections.flatMap((s) => s.settings.map((d) => [d.path, d]))),
      };
      if (!schema.tiers.some((t) => t.id === tier)) tier = schema.tiers[0].id;
      if (!active || !sections.some((s) => s.id === active)) active = sections[0]?.id ?? null;
      render();
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn’t load settings: ${esc(err.message)}</div>`;
    }
  }

  // ── interaction ──────────────────────────────────────────────────────
  host.addEventListener('click', async (e) => {
    const tierBtn = e.target.closest('[data-tier]');
    if (tierBtn) {
      if (Object.keys(dirty()).length && !window.confirm('Discard your unsaved changes?')) return;
      tier = tierBtn.dataset.tier;
      active = null;
      render();
      return;
    }

    const tab = e.target.closest('[data-cat]');
    if (tab) {
      // Switching category with unsaved edits would silently discard them.
      if (Object.keys(dirty()).length && !window.confirm('Discard your unsaved changes?')) return;
      active = tab.dataset.cat;
      render();
      return;
    }

    const sw = e.target.closest('.set-switch');
    if (sw) {
      sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      syncBar();
      return;
    }

    const seg = e.target.closest('.set-seg');
    if (seg) {
      for (const b of seg.parentElement.querySelectorAll('.set-seg')) {
        const on = b === seg;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      syncBar();
      return;
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'revert') { load(); return; }
    if (act !== 'save') return;

    const updates = dirty();
    if (!Object.keys(updates).length) return;
    const btn = e.target.closest('[data-act="save"]');
    btn.disabled = true;
    host.querySelectorAll('.set-row-error').forEach((n) => { n.textContent = ''; });

    try {
      const res = await rpc('settings.set', { updates });
      if (!res.ok) {
        // Errors land on the field that caused them, and the row is marked so
        // it is findable without hunting the category.
        for (const [path, msg] of Object.entries(res.errors || {})) {
          const slot = host.querySelector(`[data-error-for="${path}"]`);
          if (slot) slot.textContent = msg;
          host.querySelector(`[data-row="${path}"]`)?.classList.add('invalid');
        }
        toast({ variant: 'error', message: 'Some settings were not saved.', hint: 'The fields with a message were rejected; nothing was written.' });
        return;
      }
      await load();
      toast({
        variant: 'success',
        message: `Saved ${res.changed.length} setting${res.changed.length === 1 ? '' : 's'}.`,
        hint: res.restartRequired
          ? `${res.restartFor.join(', ')} ${res.restartFor.length === 1 ? 'takes' : 'take'} effect after a daemon restart.`
          : undefined,
      });
    } catch (err) {
      toast({ variant: 'error', message: `Couldn’t save: ${err.message}`, code: err.code });
    } finally {
      btn.disabled = false;
    }
  });

  host.addEventListener('input', (e) => {
    const search = e.target.closest('.set-search input');
    if (search) {
      query = search.value.trim().toLowerCase();
      const at = search.selectionStart;
      render();
      const next = el('.set-search input');
      next.focus();
      next.setSelectionRange(at, at);
      return;
    }
    const range = e.target.closest('input[type="range"]');
    if (range) {
      // Live readout: a slider without its value is a guess.
      range.parentElement.querySelector('.set-range-out').textContent = range.value;
    }
    if (e.target.closest('[data-path]')) syncBar();
  });

  // Keyboard parity for the custom controls — a switch that only responds to
  // the mouse is not a control, it is a picture of one.
  host.addEventListener('keydown', (e) => {
    const sw = e.target.closest('.set-switch');
    if (sw && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); sw.click(); }
    const seg = e.target.closest('.set-seg');
    if (seg && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...seg.parentElement.querySelectorAll('.set-seg')];
      const i = all.indexOf(seg);
      const nextEl = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      nextEl.click();
      nextEl.focus();
    }
  });

  return { refresh: load };
}
