/**
 * Vanilla design-system primitives (translated from Sigil.zip's ui_kit). Each
 * returns a DOM node. Used by the onboarding wizard so every screen is composed
 * from the same on-brand parts: status square+word, connector cards, DB-flow
 * rows. No framework, no build step.
 */

const E = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

/** Status square + lowercase word. kind: ok|warn|danger|muted */
export function statusDot(kind, word) {
  const wrap = E('span', `status-dot ${kind}`);
  wrap.append(E('span', 'sq'), E('span', null, word));
  return wrap;
}

const CONNECTOR_STATUS = {
  connected: { kind: 'ok', word: 'connected' },
  available: { kind: 'muted', word: 'available' },
  unavailable: { kind: 'muted', word: 'not installed' },
  connecting: { kind: 'warn', word: 'connecting…' },
  error: { kind: 'danger', word: 'error' },
};

/**
 * Connector card. `onAction(id, action)` is called with action 'connect' |
 * 'disconnect' | 'retry'. `state` overrides the derived status (e.g. while a
 * connect is in flight pass 'connecting').
 */
export function connectorCard(c, onAction) {
  const status = c.uiState || c.status;
  const card = E('div', `connector-card ${status === 'unavailable' ? 'unavailable' : ''}`);
  card.dataset.id = c.id;

  const top = E('div', 'cc-top');
  top.append(E('div', 'cc-name', c.label));
  const meta = CONNECTOR_STATUS[status] || CONNECTOR_STATUS.available;
  top.append(statusDot(meta.kind, meta.word));
  card.append(top);

  card.append(E('div', 'cc-hint', c.reason && status === 'error' ? c.reason : c.hint));

  const actions = E('div', 'cc-actions');
  if (status === 'connected') {
    const b = E('button', 'btn danger', 'Disconnect');
    b.type = 'button';
    b.onclick = () => onAction(c.id, 'disconnect');
    actions.append(b);
  } else if (status === 'connecting') {
    const b = E('button', 'btn', 'Connecting…');
    b.type = 'button'; b.disabled = true;
    actions.append(b);
  } else if (status === 'unavailable') {
    // no action — not installed on this machine
  } else {
    const b = E('button', status === 'error' ? 'btn' : 'btn primary', status === 'error' ? 'Retry' : 'Connect');
    b.type = 'button';
    b.onclick = () => onAction(c.id, status === 'error' ? 'retry' : 'connect');
    actions.append(b);
  }
  card.append(actions);
  return card;
}

/**
 * A single row in the DB guided flow. phase: pending|active|done|error.
 * Returns the row element; update via setFlowRow().
 */
export function dbFlowRow(id, label) {
  const row = E('div', 'db-flow-row pending');
  row.dataset.row = id;
  row.append(E('span', 'step-sq'));
  row.append(E('span', 'step-label', label));
  row.append(E('span', 'step-detail', ''));
  return row;
}

export function setFlowRow(container, id, { phase, detail } = {}) {
  const row = container.querySelector(`[data-row="${id}"]`);
  if (!row) return;
  if (phase) row.className = `db-flow-row ${phase}`;
  if (detail != null) row.querySelector('.step-detail').textContent = detail;
}

/**
 * One field control, shared by the onboarding wizard and Settings' provider
 * switcher. It exists because they each had their own copy: both rendered
 * `<input type="${f.type}">`, so when the LLM step gained `type: 'select'`
 * model pickers, Settings silently rendered `<input type="select">` — which
 * every browser treats as a plain text box. The result was an empty field where
 * a list of models should be, with no error anywhere.
 *
 * `nameAttr` differs between the two surfaces (data-setup-field vs
 * data-cfg-field), so it's a parameter rather than a second implementation.
 */
export function fieldControl(f, nameAttr) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const optional = f.optional ? ' data-optional="1"' : '';

  if (f.type === 'select' && f.options?.length) {
    const chosen = f.default || f.options[0].value;
    const opts = f.options.map((o) => {
      const label = o.label || o.value;
      return `<option value="${esc(o.value)}"${o.value === chosen ? ' selected' : ''}>`
        + `${esc(label)}${o.hint ? ` — ${esc(o.hint)}` : ''}</option>`;
    }).join('');
    return `<select ${nameAttr}="${esc(f.name)}"${optional}>${opts}</select>`;
  }

  return `<input type="${esc(f.type)}" ${nameAttr}="${esc(f.name)}"${optional}`
    + ` placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
}

export { E };
