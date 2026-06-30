# Sigil

## Design System
Always read `DESIGN.md` before making any visual or UI decision in the dashboard
(`src/gui/web/`). All font choices, colors, spacing, geometry, and the structural
patterns (sidebar IA, page template, stat strip, KB list/detail, status pill
vocabulary, ⌘K) are defined there. The runtime token source is
`src/gui/web/design/colors_and_type.css`; DESIGN.md mirrors it and owns the
patterns the CSS doesn't encode. Do not deviate without explicit user approval.
When reviewing UI code, flag anything that doesn't match DESIGN.md.
