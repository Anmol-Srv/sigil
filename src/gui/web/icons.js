/**
 * Icon set — 16px monoline SVG, `currentColor` stroke, no fills.
 *
 * One geometric family at a single stroke weight, per DESIGN.md's
 * "industrial / utilitarian console" lock: icons are wayfinding, not
 * decoration. They appear in the sidebar, on action buttons, and as group
 * markers in ⌘K — never inside body copy, never as an empty-state illustration.
 *
 * Usage: `icon('search')` returns markup; static markup can instead carry
 * `data-icon="search"` and be hydrated once at boot by `hydrateIcons()`.
 */

const PATHS = {
  // ── navigation ──
  home:     '<path d="M2 6.4 8 2l6 4.4V14H2z"/><path d="M6 14v-4h4v4"/>',
  layers:   '<path d="M8 2 2 5l6 3 6-3-6-3Z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
  graph:    '<circle cx="3.8" cy="12.2" r="1.8"/><circle cx="12.2" cy="12.2" r="1.8"/><circle cx="8" cy="3.4" r="1.8"/><path d="M6.6 4.8 4.9 10.5M9.4 4.8l1.7 5.7M5.6 12.2h4.8"/>',
  activity: '<path d="M1.5 8h3l2-5 3 10 2-5h3"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4.6 6.4 6.9 8.4 4.6 10.4M8.8 10.8h3"/>',
  monitor:  '<rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5.5 14h5M8 11.5V14"/>',
  cpu:      '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1"/><path d="M6.6 1.6v3M9.4 1.6v3M6.6 11.4v3M9.4 11.4v3M1.6 6.6h3M1.6 9.4h3M11.4 6.6h3M11.4 9.4h3"/>',
  sliders:  '<path d="M2 4.6h7M12.6 4.6H14M2 11.4h1.4M7 11.4h7"/><circle cx="10.8" cy="4.6" r="1.7"/><circle cx="5.2" cy="11.4" r="1.7"/>',
  database: '<ellipse cx="8" cy="3.9" rx="5.4" ry="2.3"/><path d="M2.6 3.9v8.2c0 1.27 2.42 2.3 5.4 2.3s5.4-1.03 5.4-2.3V3.9"/><path d="M2.6 8c0 1.27 2.42 2.3 5.4 2.3s5.4-1.03 5.4-2.3"/>',
  doc:      '<path d="M9.2 1.6H4.2a.6.6 0 0 0-.6.6v11.6a.6.6 0 0 0 .6.6h7.6a.6.6 0 0 0 .6-.6V5z"/><path d="M9.2 1.6V5h3.2"/>',

  // ── actions ──
  search:   '<circle cx="7.1" cy="7.1" r="4.6"/><path d="m10.5 10.5 3 3"/>',
  refresh:  '<path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"/><path d="M13.7 2.6v3.2h-3.2"/>',
  plus:     '<path d="M8 3v10M3 8h10"/>',
  trash:    '<path d="M2.6 4.4h10.8M6 4.4V3a.6.6 0 0 1 .6-.6h2.8a.6.6 0 0 1 .6.6v1.4"/><path d="m4.1 4.4.6 8.6a.6.6 0 0 0 .6.5h5.4a.6.6 0 0 0 .6-.5l.6-8.6"/>',
  copy:     '<rect x="5.6" y="5.6" width="8" height="8" rx="1"/><path d="M10.4 5.6V3.4a1 1 0 0 0-1-1H3.4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.2"/>',
  external: '<path d="M9.5 2.5H13.5V6.5"/><path d="M13.5 2.5 7.6 8.4"/><path d="M12 9.6v3.3a.6.6 0 0 1-.6.6H3.1a.6.6 0 0 1-.6-.6V4.6a.6.6 0 0 1 .6-.6h3.3"/>',

  // ── state / meaning ──
  zap:      '<path d="M9.1 1.6 3.4 9h4.1l-.6 5.4L12.6 7H8.5z"/>',
  alert:    '<path d="M8 2.4 14.4 13.6H1.6z"/><path d="M8 6.6v3.1"/><path d="M8 11.9h.01"/>',
  check:    '<path d="m3 8.4 3.3 3.3L13 5"/>',
  shield:   '<path d="M8 1.8 13.2 4v4.2c0 3-2.2 5-5.2 6-3-1-5.2-3-5.2-6V4z"/><path d="m5.9 8.1 1.5 1.5 2.8-2.8"/>',
  pulse:    '<circle cx="8" cy="8" r="2"/><path d="M3.4 3.4a6.5 6.5 0 0 0 0 9.2M12.6 12.6a6.5 6.5 0 0 0 0-9.2"/>',

  // ── affordances ──
  chevron:  '<path d="m6 3.6 4.5 4.4L6 12.4"/>',
  arrow:    '<path d="M2.6 8h10.4M9.2 4.2 13 8l-3.8 3.8"/>',
  close:    '<path d="m4 4 8 8M12 4l-8 8"/>',
};

export function icon(name, cls = '') {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 16 16" width="16" height="16" `
    + `fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" `
    + `stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
}

/**
 * Inject icons into static markup once. Elements opt in with `data-icon="name"`
 * and the SVG is prepended; the flag attribute stops a second pass from
 * double-injecting if this is ever called again.
 */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]:not([data-icon-done])')) {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.setAttribute('data-icon-done', '');
  }
}
