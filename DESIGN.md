# Design System — Sigil

> Source of truth for every visual and UI decision in the Sigil dashboard.
> Tokens here mirror `src/gui/web/design/colors_and_type.css` (the runtime source).
> If the two ever disagree, the CSS file wins for values; this file owns the
> *patterns* (IA, page template, components) that the CSS doesn't encode.

## Product Context
- **What this is:** Local-first memory infrastructure for AI coding agents. A
  background daemon stores facts captured from agent sessions (Claude Code,
  Codex, Cursor, Kiro, MCP clients) in the user's own Postgres, organized in
  pods/namespaces, linked into a knowledge graph, and recalled via hybrid search.
- **Who it's for:** Developers who run the daemon on their own machine and want
  their agents to share one memory.
- **The dashboard's job:** The whole command center — setup, browsing and
  correcting memory, connecting agents, managing devices, configuring providers,
  and monitoring activity.
- **Memorable thing:** *"Mission control for my agents' memory — everything they've
  learned, on my machine, fully in my view and fully in my control."* Every layout
  decision serves this: status at a glance, memory as the hero, plumbing tucked away.

## Aesthetic Direction
- **Direction:** Industrial / utilitarian console. Dark, sharp-edged, data-dense.
- **Decoration level:** Minimal. Typography and a single accent do the work.
- **Mood:** A serious instrument you operate, not a card-based marketing surface.
  Near-black surfaces, monospace for anything machine-derived, color used rarely
  and only when it means something.
- **Locked:** This identity is decided and deliberate. Do not introduce gradients
  as decoration, sparklines/finance cues, multi-color palettes, or rounded "soft"
  UI. When in doubt, make it quieter and sharper, not louder.

## Color
Cool-neutral dark ramp. Chroma kept extremely low; semantic color is the exception,
never the rule.

### Surfaces (low → high elevation)
| Token | Hex | Use |
|---|---|---|
| `--bg-0` | `#08090b` | app background / sidebar, deepest |
| `--bg-1` | `#0b0c0e` | page canvas |
| `--surface-1` | `#101113` | card / panel |
| `--surface-2` | `#151618` | row hover, inset, raised |
| `--surface-3` | `#1b1d20` | active / pressed surface |

### Borders
`--border-1 #1d1f23` (default hairline) · `--border-2 #292c31` (card edge) ·
`--border-strong #3a3e44` (input hover, focus-adjacent).

### Text ramp
`--fg-1 #f4f5f6` (primary / headings / key values) · `--fg-2 #a2a5ab` (body) ·
`--fg-3 #82858c` (labels, captions — meets WCAG AA ≥4.9:1 on all surfaces) ·
`--fg-4 #50535a` (disabled / decorative faint meta only — not for real info text).

### Brand (from the Sigil mark gradient)
`--brand #0084ff` (links, active, focus) · `--brand-deep #004ce6` (pressed) ·
`--brand-light #99d5ff` (on-dark accents) · `--brand-tint rgba(0,132,255,.12)`
(selected/active wash) · `--brand-ring rgba(0,132,255,.45)` (focus ring).

### Semantic (used sparingly)
`--ok #3ddc84` · `--warn #f5b544` · `--danger #ff5a52`, each with a `-tint`
at 12% alpha. Never use semantic color decoratively. A green number, an amber
border, a red pill must each report a real state.

- **No dark-mode variant.** The product is dark-only by design.

## Typography
Geist for UI; Geist Mono for anything machine-derived (pids, ids, hashes,
versions, durations, counts, scores, namespaces). Loaded via `<link>` in
`index.html`, not `@import`.

- **Display / hero (rare):** Geist 700, `--text-display 2.25rem`, tracking `-.01em`
- **Page title (h1):** Geist 700, `--text-h1 1.625rem`, tracking `-.01em`
- **Section / card value (h2):** Geist 600, `--text-h2 1.125rem`
- **Sub-section (h3):** Geist 600, `--text-h3 1rem`
- **Body:** Geist 400, `--text-body .9375rem`, line-height 1.55
- **Table cells / meta:** `--text-sm .8125rem`
- **Eyebrow label (UPPERCASE):** Geist 600, `--text-label .6875rem`, tracking `.12em`
- **Micro meta:** `--text-xs .625rem`
- **Data / mono:** Geist Mono, `font-feature-settings: 'ss01' on, 'zero' on`
- Weights: 400 / 500 / 600 / 700. Line heights: tight 1.15, snug 1.35, body 1.55.

**Rule:** if a value is produced by the machine (a count, an id, a latency, a
score, a timestamp, a namespace), render it in Geist Mono. If it's prose the
user reads, render it in Geist.

## Spacing & Geometry
- **Base grid:** 4px. Scale: `--sp-1 4` `--sp-2 8` `--sp-3 12` `--sp-4 16`
  `--sp-5 24` `--sp-6 32` `--sp-7 48` `--sp-8 64` `--sp-9 96`.
- **Density:** Compact. This is a console; favor information density over air.
- **Radius (sharp by design):** `--radius-0 0` (default) · `--radius-1 2px`
  (inputs, badges, pills) · `--radius-2 3px` (cards — the largest we ever go).
  Never round more than 3px.
- **Borders:** 1px hairlines (`--bw`). Structure is drawn with borders, not shadows.
- **Layout:** content `max-width 1680px`; page gutter 24–32px; sidebar `236px`.

## Motion
- **Approach:** Minimal-functional. Only transitions that aid comprehension.
- **Easing:** `--ease cubic-bezier(.2,0,0,1)`. No bounce, no spring.
- **Duration:** `--dur-1 90ms` (hover/press) · `--dur-2 150ms` (panel/route).
- **Focus:** `--focus-ring: 0 0 0 1px var(--brand), 0 0 0 4px var(--brand-ring)`.

---

# Structural Patterns (the extension layer)

These are the patterns the token file doesn't encode. They are what keep the
multi-domain command center coherent as it grows. Validated against a
token-accurate preview (`/tmp/sigil-redesign-preview.html` at design time).

## Information Architecture — two-tier left sidebar
Replace the flat top-nav with a grouped left sidebar (`--bg-0`, 236px,
collapsible to icon-only for data-dense pages).

```
MEMORY        Home · Knowledge Base · Graph · Activity
CONNECTIONS   Agents · Devices
SYSTEM        Engine · Settings
```

- **Sidebar top:** brand mark + a **status pill** (`Memory active · N agents · synced`).
  This replaces PID/uptime/node-id as the at-a-glance health signal.
- **Group headers** use the uppercase eyebrow label style (`--text-label`, `--fg-3`).
- **Active item:** `--brand-tint` background + 2px `--brand` left border + `--fg-1` text.
- **Hover:** `--surface-2`.
- **Group badge:** a small **dot** (never a count) appears on a group when something
  inside is in Warning/Error state.
- **Sidebar foot:** version (mono) + a `diagnostics` link. Diagnostics is where the
  old plumbing lives (pid, uptime, node-id, relay).

### What moved / was cut
- **RPC methods** page → removed from nav; lives behind a Developer disclosure in
  Settings. It is an internal API catalog, not a user surface.
- **Setup / Database** tab → merged into **Settings** (config must live in one place).
- **Coding agents** (was buried inside Settings) → promoted to top-level **Agents**.
- **PID / uptime / node-id** (was the Overview headline) → status pill + Diagnostics.

## Page template (every content page, identical)
```
[ breadcrumb → Title ]   [ sub-view tabs ]   ········   [ right actions | time-range ]
[ ─ conditional filter row: only rendered when a filter is active ─────────────────── ]
[ ─ body ────────────────────────────────────────────────────────────────────────── ]
```
- **Header:** `h1` title + a one-line purpose sentence (`--text-sm`, `--fg-3`,
  max ~60ch). Right-aligned actions are icon/secondary buttons.
- **Time-range control** (`24h / 7d / 30d / all`) sits top-right on every page that
  has temporal data — same position everywhere, never elsewhere.
- **Detail opens in a right-side panel**, never a navigation away — the list stays
  visible for context.
- Consistency of this template across pages is most of the redesign. Do not let
  individual pages invent their own header layout.

## Stat strip
A row of 3–5 calm readout cards at the top of a page. **No trading-desk cues** —
no background sparklines, no red/green directional arrows, no gradient washes.

Card anatomy (top to bottom): uppercase **label** (`--text-label`, `--fg-3`,
optional leading status dot) → **value** in Geist Mono (~1.7rem, `--fg-1`) →
one **muted sub-line** (`--text-xs`, `--fg-4`) for context or a quiet delta
("+37 this week", "418 searches · 7d").

- Color appears only as a single small status dot on the label when the metric
  carries a state (e.g. green dot on a healthy recall rate, amber on dupes-to-review).
- The strip is read-only; clicking a card navigates to its detail view.

## Knowledge Base browser (list + detail)
Two-column: a searchable list on the left, a detail panel on the right.

- **List:** search input + namespace/category **filter chips** (mono, `--brand-tint`
  when active) + rows. Each row shows the fact text, namespace, category, and a
  mono hit-count (the ACT-R access count).
- **Detail panel — leads with trust.** Order: the fact text → **provenance**
  (source agent, session, captured-at, confidence, pod) → **activation** (ACT-R:
  access count, last recalled, activation score with a thin bar) → linked entities
  → related facts → **actions: Edit · Pin · Supersede · Delete** (delete is the only
  `--danger` button, right-aligned).
- Provenance-first + correctable is the product's differentiator. Treat "why is
  this fact here, and can I fix it" as the primary job of this page.

## Activity timeline
- **Typed event rows** in plain language first: a mono category tag
  (`search` / `ingest` / `engine` / `lifecycle`), a human summary
  (`claude-code searched "…" → 4 facts · 118ms`), source, relative time.
- The full scoring trace (cosine, RRF fusion, ACT-R activation, final rank) lives
  one layer down — click a row to open it in the right panel. Do not lead with the
  jargon.
- Filters: type chips + agent chips + time range. Optional volume histogram on top
  (drag to zoom) once the data supports it.

## Devices
- **Three-state presence**, never binary online/offline: `Active` / `Idle (N ago)` /
  `Last seen N ago` (mono relative time).
- Per-device row: name, NodeID (mono), role badge, namespaces, last-seen, status pill,
  per-row actions menu (revoke is destructive, behind the menu).
- Pairing: show the code/NodeID as text (a QR code is a good future add); pending
  codes get an explicit pending state.

## Status pill vocabulary (one set, everywhere)
Five states, identical hex on every surface (sidebar badges, rows, stat-card dots,
activity rows, health indicators):

| State | Token | Meaning |
|---|---|---|
| Active | `--brand` | session running, sync live, indexing |
| Idle | `--fg-3` | open but quiet |
| Healthy | `--ok` | check passed |
| Warning | `--warn` | degraded / approaching a limit / needs review |
| Error | `--danger` | failed op, crashed session, corrupt fact |

Pills are small (~`--text-xs`), never wrap, and are clickable — clicking jumps to a
pre-filtered view for that state. Never invent ad-hoc colors outside this set.

## Global ⌘K
A single fuzzy bar in the top chrome, three implicit modes (no hard tabs):
**Navigate** (jump to any page) · **Act** (new fact, add device, export) ·
and the fallback: **any unmatched query runs a live hybrid memory search**. The
command bar embodies the product. Show the keyboard shortcut next to every action.

## Components — quick reference
- **Buttons:** `.btn` (surface-1 / border-2), `.btn.primary` (brand fill, white
  text), `.btn.danger` (danger text, danger-tint on hover), `.btn.sm`. Radius 2px.
- **Inputs:** `--bg-1` fill, `--border-2`, focus → `--focus-ring`. Radius 2px.
- **Cards/panels:** `--surface-1` + `--border-1`, radius 3px, 16px padding.
- **Tables:** hairline row borders, `--surface-2` hover, mono for machine columns.
- **Empty states:** one muted line with an inline `code` hint of the command that
  would populate it. No illustrations.

---

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-30 | DESIGN.md created via /design-consultation (codify + extend) | Sigil had a strong hand-authored token system but no documented structural patterns; pages had drifted (Setup vs Settings, leaked PIDs, an RPC tab). Codify the locked aesthetic, add the IA/template/component layer. |
| 2026-06-30 | Aesthetic locked: dark industrial console, unchanged | Deliberate, working identity that fits local-first dev infrastructure. Competitive research (AI-memory, dev-infra, command-center craft) informed IA/features, not the look. |
| 2026-06-30 | Two-tier sidebar (MEMORY / CONNECTIONS / SYSTEM) replaces flat 9-tab top nav | Multi-domain command center needs hierarchy; flat tabs mixed core memory with plumbing. |
| 2026-06-30 | Cut RPC page from nav; merge Setup into Settings; promote Agents to top-level | Remove leaked internals from user surfaces; config in one place; surface the highest-value connection management. |
| 2026-06-30 | Replace PID/uptime/node-id headline with a status pill + Diagnostics drawer | A PID is a once-a-year escape hatch, not a metric. Users care whether memory is working. |
| 2026-06-30 | Stat cards are calm console readouts — no sparklines/arrows/gradients | Trading-desk/observability cues fight the restrained "color is rare and meaningful" aesthetic. |
| 2026-06-30 | KB detail leads with provenance + activation + correctable actions | First-principles differentiator: memory is local and user-owned, so make it legible and editable — the thing opaque vector stores can't offer. |
