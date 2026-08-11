/**
 * Settings — rendered from the daemon's schema, not hand-written.
 *
 * Every control here is generated from `settings.schema`, so a knob added to
 * settings-schema.js shows up with no dashboard change and the page can never
 * offer something the daemon won't honour. That is the whole point: config.json
 * had grown a couple of dozen settings — AUDM thresholds, Hebbian decay,
 * managed-session sizing — that were only reachable by hand-editing JSON.
 *
 * Saving is per-section and explicit. An input that writes on blur is hostile
 * for a threshold you are mid-thought about, and these values change ranking
 * behaviour; you should be able to type, look, and then commit.
 */
import { icon } from './icons.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fieldId = (path) => `set-${path.replace(/\./g, '-')}`;

function control(d) {
  const id = fieldId(d.path);
  if (d.type === 'boolean') {
    return `<label class="set-toggle">
      <input type="checkbox" id="${id}" data-path="${esc(d.path)}" data-type="boolean"${d.value ? ' checked' : ''}>
      <span>${esc(d.label)}</span>
    </label>`;
  }
  if (d.type === 'enum') {
    return `<label class="set-field"><span class="label">${esc(d.label)}</span>
      <select id="${id}" data-path="${esc(d.path)}" data-type="enum">
        ${d.options.map((o) => `<option value="${esc(o)}"${o === d.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select></label>`;
  }
  const numeric = d.type === 'number';
  const attrs = numeric
    ? ` type="number"${d.min != null ? ` min="${d.min}"` : ''}${d.max != null ? ` max="${d.max}"` : ''}${d.step != null ? ` step="${d.step}"` : ''}`
    : ' type="text"';
  return `<label class="set-field"><span class="label">${esc(d.label)}</span>
    <input id="${id}" data-path="${esc(d.path)}" data-type="${d.type}"${attrs}
      value="${esc(d.value ?? '')}" placeholder="${esc(d.placeholder || '')}" autocomplete="off"></label>`;
}

function row(d) {
  return `<div class="set-row${d.restart ? ' needs-restart' : ''}">
    ${control(d)}
    ${d.help ? `<p class="set-help">${esc(d.help)}</p>` : ''}
    <div class="set-error" data-error-for="${esc(d.path)}"></div>
  </div>`;
}

function section(s) {
  return `<section class="panel set-section" data-section="${esc(s.id)}">
    <div class="set-head">
      <h3>${esc(s.title)}</h3>
      ${s.help ? `<p class="set-section-help">${esc(s.help)}</p>` : ''}
    </div>
    <div class="set-grid">${s.settings.map(row).join('')}</div>
    <div class="set-actions">
      <span class="set-status" data-status-for="${esc(s.id)}"></span>
      <button class="btn" type="button" data-revert="${esc(s.id)}">Revert</button>
      <button class="btn primary" type="button" data-save="${esc(s.id)}">Save</button>
    </div>
  </section>`;
}

export function initSettings({ rpc, toast, mount }) {
  const host = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!host) return { refresh: () => {} };
  let schema = null;

  const valueOf = (el) => {
    if (el.dataset.type === 'boolean') return el.checked;
    if (el.dataset.type === 'number') return el.value === '' ? '' : Number(el.value);
    return el.value;
  };

  function dirtyIn(sectionEl) {
    const out = {};
    for (const el of sectionEl.querySelectorAll('[data-path]')) {
      const def = schema.flat.get(el.dataset.path);
      const now = valueOf(el);
      const was = def.value ?? (def.type === 'boolean' ? false : '');
      // Compare loosely: a number field returns 0.88 for a stored "0.88".
      if (String(now) !== String(was)) out[el.dataset.path] = now;
    }
    return out;
  }

  async function render() {
    host.innerHTML = '<div class="empty">Loading settings…</div>';
    try {
      const { sections } = await rpc('settings.schema');
      schema = {
        sections,
        flat: new Map(sections.flatMap((s) => s.settings.map((d) => [d.path, d]))),
      };
      host.innerHTML = sections.map(section).join('');
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn’t load settings: ${esc(err.message)}</div>`;
    }
  }

  host.addEventListener('click', async (e) => {
    const revert = e.target.closest('[data-revert]');
    if (revert) { render(); return; }

    const save = e.target.closest('[data-save]');
    if (!save) return;
    const sectionEl = save.closest('.set-section');
    const status = sectionEl.querySelector('[data-status-for]');
    sectionEl.querySelectorAll('.set-error').forEach((n) => { n.textContent = ''; });

    const updates = dirtyIn(sectionEl);
    if (!Object.keys(updates).length) { status.textContent = 'No changes'; return; }

    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      const res = await rpc('settings.set', { updates });
      if (!res.ok) {
        // Errors land on the field that caused them, not in one blob at the top.
        for (const [path, msg] of Object.entries(res.errors || {})) {
          const slot = sectionEl.querySelector(`[data-error-for="${path}"]`);
          if (slot) slot.textContent = msg;
        }
        status.textContent = 'Not saved';
        return;
      }
      // Re-read so the form shows what the daemon actually stored, including
      // any value it normalised on the way in.
      await render();
      const changed = res.changed.length;
      toast({
        variant: 'success',
        message: `Saved ${changed} setting${changed === 1 ? '' : 's'}.`,
        hint: res.restartRequired
          ? `${res.restartFor.join(', ')} ${res.restartFor.length === 1 ? 'takes' : 'take'} effect after a daemon restart.`
          : undefined,
      });
    } catch (err) {
      status.textContent = '';
      toast({ variant: 'error', message: `Couldn’t save: ${err.message}`, code: err.code });
    } finally {
      save.disabled = false;
    }
  });

  // Surface the restart requirement before the user commits, not after.
  host.addEventListener('input', (e) => {
    const el = e.target.closest('[data-path]');
    if (!el) return;
    const sectionEl = el.closest('.set-section');
    const n = Object.keys(dirtyIn(sectionEl)).length;
    const status = sectionEl.querySelector('[data-status-for]');
    status.textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : '';
  });

  return { refresh: render, icon };
}
