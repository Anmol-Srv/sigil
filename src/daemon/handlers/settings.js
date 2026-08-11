/**
 * settings.schema / settings.set — the generic configuration surface.
 *
 * The daemon owns the schema and the GUI renders whatever it is given, so a
 * knob added to settings-schema.js appears in Settings without touching the
 * dashboard, and the UI can never offer something the daemon does not honour.
 *
 * Writes are whitelisted BY that schema: a path absent from it is rejected
 * rather than written, which is what keeps secrets and internal identity
 * (apiKey, device.id, setup.steps) out of a generic setter.
 */
import { getConfig, patchConfig } from '../../setup/config-store.js';
import {
  SETTINGS_SECTIONS, SETTINGS_TIERS, SETTINGS_BY_PATH, readPath, coerce,
} from '../../setup/settings-schema.js';

/** Set a dotted path on a plain object, creating containers as needed. */
function writePath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) {
    if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  node[last] = value;
}

export function registerSettings(registry) {
  // The schema, with each setting's CURRENT value inlined — one round trip
  // renders the whole page.
  registry.register('settings.schema', async () => {
    const cfg = getConfig();
    return {
      tiers: SETTINGS_TIERS,
      sections: SETTINGS_SECTIONS.map((s) => ({
        id: s.id,
        tier: s.tier || 'advanced',
        title: s.title,
        help: s.help || null,
        settings: s.settings.map((d) => ({ ...d, value: readPath(cfg, d.path) ?? null })),
      })),
    };
  });

  registry.register('settings.set', async (params = {}) => {
    const updates = params.updates && typeof params.updates === 'object' ? params.updates : {};
    const paths = Object.keys(updates);
    if (!paths.length) return { ok: true, changed: [], restartRequired: false };

    // Validate everything BEFORE writing anything — a partial save across a
    // set of related knobs (pool size without its budget) is worse than none.
    const errors = {};
    const accepted = [];
    for (const path of paths) {
      const def = SETTINGS_BY_PATH.get(path);
      if (!def) { errors[path] = 'not a configurable setting'; continue; }
      const r = coerce(def, updates[path]);
      if (!r.ok) { errors[path] = r.error; continue; }
      accepted.push({ def, path, value: r.value });
    }
    if (Object.keys(errors).length) return { ok: false, errors };

    // Group by top-level section: patchConfig merges shallowly, so a nested
    // path has to be applied onto a COPY of the whole current section or its
    // siblings (every other managedSession key) would be dropped.
    const cfg = getConfig();
    const bySection = new Map();
    for (const a of accepted) {
      const section = a.path.split('.')[0];
      if (!bySection.has(section)) {
        bySection.set(section, JSON.parse(JSON.stringify(cfg[section] ?? {})));
      }
      writePath(bySection.get(section), a.path.split('.').slice(1).join('.'), a.value);
    }

    for (const [section, values] of bySection) patchConfig(section, values);

    const restartRequired = accepted.some((a) => a.def.restart);
    return {
      ok: true,
      changed: accepted.map((a) => a.path),
      restartRequired,
      // Named so the UI can say WHICH change needs the restart, rather than
      // asking for one and leaving the user to guess why.
      restartFor: accepted.filter((a) => a.def.restart).map((a) => a.def.label),
    };
  });
}
