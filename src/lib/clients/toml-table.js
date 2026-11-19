/**
 * Edit one TOML table as text, so the rest of the file stays byte-for-byte.
 *
 * Parsing ~/.codex/config.toml and writing it back out (what @iarna/toml does)
 * drops every comment and can reorder tables. Users keep notes and disabled
 * settings in that file, so Sigil splices only its own `[mcp_servers.sigil]`
 * block (and sub-tables such as `[mcp_servers.sigil.env]`) and leaves every
 * other line alone. The parser is used only to check the result.
 */

import TOML from '@iarna/toml';

// A table header line: [a.b] or [[a.b]], with an optional trailing comment.
const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/;

/** Normalize a dotted table name: drop quotes and spaces around segments. */
function normalizeName(name) {
  return name
    .split('.')
    .map((seg) => seg.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.');
}

function ownsHeader(headerName, table) {
  const n = normalizeName(headerName);
  return n === table || n.startsWith(`${table}.`);
}

/**
 * Remove `[table]` and its sub-tables from TOML text. Comments and blank lines
 * directly above the header stay (they may belong to the previous table).
 */
export function removeTomlTable(text, table) {
  const lines = text.split('\n');
  const out = [];
  let skipped = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(HEADER);
    if (m) {
      const owned = ownsHeader(m[1], table);
      if (skipping && !owned) {
        // Comments right above the next table describe that table, not ours.
        let i = skipped.length;
        while (i > 0 && /^\s*(#.*)?$/.test(skipped[i - 1])) i--;
        out.push(...skipped.slice(i));
      }
      skipping = owned;
      skipped = [];
    }
    if (skipping) skipped.push(line);
    else out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Does the text contain a `[table]` header (or a sub-table of it)? */
export function hasTomlTable(text, table) {
  return text.split('\n').some((line) => {
    const m = line.match(HEADER);
    return Boolean(m && ownsHeader(m[1], table));
  });
}

/** Render `value` as a TOML block under `[table]`. */
export function renderTomlTable(table, value) {
  let obj = value;
  for (const seg of table.split('.').reverse()) obj = { [seg]: obj };
  return TOML.stringify(obj).trim();
}

function getPath(obj, table) {
  return table.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * Replace (or add) `[table]` with `value`, preserving everything else.
 * Returns { text, lossless }. lossless=false means the table was defined in a
 * form the splice can't edit (e.g. an inline `sigil = { ... }` under
 * `[mcp_servers]`) and the file had to be re-serialized, which drops comments.
 * Throws if the original isn't valid TOML.
 */
export function upsertTomlTable(text, table, value) {
  TOML.parse(text); // throws on invalid input; the caller refuses to touch it
  const stripped = removeTomlTable(text, table).replace(/\s+$/, '');
  const block = renderTomlTable(table, value);
  const next = `${stripped ? `${stripped}\n\n` : ''}${block}\n`;
  try {
    const parsed = TOML.parse(next);
    if (JSON.stringify(getPath(parsed, table)) === JSON.stringify(value)) return { text: next, lossless: true };
  } catch { /* fall through to a full rewrite */ }

  const parsed = TOML.parse(text);
  const segs = table.split('.');
  let node = parsed;
  for (const seg of segs.slice(0, -1)) {
    if (!node[seg] || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  node[segs.at(-1)] = value;
  return { text: TOML.stringify(parsed), lossless: false };
}

/**
 * Remove `[table]` from TOML text. Returns { text, removed, lossless }.
 * Throws if the original isn't valid TOML.
 */
export function deleteTomlTable(text, table) {
  const before = TOML.parse(text);
  if (getPath(before, table) === undefined) return { text, removed: false, lossless: true };

  const next = removeTomlTable(text, table);
  try {
    if (getPath(TOML.parse(next), table) === undefined) return { text: next, removed: true, lossless: true };
  } catch { /* fall through */ }

  const segs = table.split('.');
  const parent = getPath(before, segs.slice(0, -1).join('.'));
  if (parent) delete parent[segs.at(-1)];
  if (parent && segs.length > 1 && Object.keys(parent).length === 0) {
    const grand = segs.length > 2 ? getPath(before, segs.slice(0, -2).join('.')) : before;
    delete grand[segs.at(-2)];
  }
  return { text: TOML.stringify(before), removed: true, lossless: false };
}
