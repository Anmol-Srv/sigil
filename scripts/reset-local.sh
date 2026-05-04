#!/usr/bin/env bash
#
# reset-local.sh — Reset the local Cortex install for testing.
#
# Tears down any existing global install (if installed via npm link / pack),
# clears Claude Code hook + @import config, and optionally wipes the data dir.
#
# Then rebuilds from this repo, packs, and reinstalls globally — leaving you
# with a fresh `cortex` binary you can run `cortex init` against.
#
# Usage:
#   ./scripts/reset-local.sh                  # Wipe everything (data + config + reinstall)
#   ./scripts/reset-local.sh --keep-data      # Preserve ~/.cortex/db (keeps facts/docs)
#   ./scripts/reset-local.sh --no-install     # Only tear down — don't reinstall
#   ./scripts/reset-local.sh --keep-data --no-install
#
# Flags:
#   --keep-data    Don't delete ~/.cortex/db (preserve PGlite database)
#   --no-install   Don't pack + reinstall after teardown

set -euo pipefail

KEEP_DATA=false
DO_INSTALL=true

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=true ;;
    --no-install) DO_INSTALL=false ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \?//' | head -n 25
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_CORTEX="${HOME}/.cortex"
HOME_CLAUDE="${HOME}/.claude"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
gray()  { printf "\033[90m%s\033[0m\n" "$*"; }

cyan "── Cortex local reset ──────────────────────────────────"
gray "  Repo:        $REPO_DIR"
gray "  Keep data:   $KEEP_DATA"
gray "  Reinstall:   $DO_INSTALL"
echo

# 1. Uninstall global cortex (if present)
if command -v cortex >/dev/null 2>&1; then
  yellow "▸ Uninstalling existing global @anmol-srv/cortex..."
  npm uninstall -g @anmol-srv/cortex 2>/dev/null || true
  npm unlink -g @anmol-srv/cortex 2>/dev/null || true
  green "  done"
else
  gray "  no global cortex on PATH — skipping uninstall"
fi

# 2. Strip Cortex hooks from ~/.claude/settings.json
if [ -f "${HOME_CLAUDE}/settings.json" ]; then
  yellow "▸ Removing Cortex hooks from ~/.claude/settings.json..."
  python3 - <<'PY' || echo "  (python3 not available — skipping JSON cleanup)"
import json, pathlib, sys
p = pathlib.Path.home() / '.claude' / 'settings.json'
try:
    s = json.loads(p.read_text())
except Exception as e:
    print(f"  could not parse settings.json: {e}", file=sys.stderr)
    sys.exit(0)

hooks = s.get('hooks', {})
removed_events = []
for evt in list(hooks.keys()):
    before = len(hooks[evt])
    hooks[evt] = [
        h for h in hooks[evt]
        if not any('cortex' in (i.get('command', '') or '').lower()
                   or 'cortex' in (i.get('command', '') or '')
                   for i in h.get('hooks', []))
    ]
    after = len(hooks[evt])
    if after < before:
        removed_events.append(f"{evt}({before - after})")
    if not hooks[evt]:
        del hooks[evt]

if not hooks and 'hooks' in s:
    del s['hooks']
elif 'hooks' in s:
    s['hooks'] = hooks

p.write_text(json.dumps(s, indent=2))
print(f"  removed: {', '.join(removed_events) if removed_events else 'none'}")
PY
fi

# 3. Strip the @import line from ~/.claude/CLAUDE.md
if [ -f "${HOME_CLAUDE}/CLAUDE.md" ]; then
  yellow "▸ Removing @import from ~/.claude/CLAUDE.md..."
  before_lines=$(wc -l < "${HOME_CLAUDE}/CLAUDE.md")
  sed -i.cortex-bak '/cortex\/CLAUDE\.md/d' "${HOME_CLAUDE}/CLAUDE.md"
  after_lines=$(wc -l < "${HOME_CLAUDE}/CLAUDE.md")
  rm -f "${HOME_CLAUDE}/CLAUDE.md.cortex-bak"
  gray "  $((before_lines - after_lines)) line(s) removed"
fi

# 4. Wipe ~/.cortex (data + config) — or preserve data
if [ -d "$HOME_CORTEX" ]; then
  if [ "$KEEP_DATA" = true ]; then
    yellow "▸ Removing config (~/.cortex/.env, CLAUDE.md) but preserving db/..."
    rm -f "${HOME_CORTEX}/.env" "${HOME_CORTEX}/CLAUDE.md" "${HOME_CORTEX}/.hook-dedup.json" 2>/dev/null || true
    gray "  data preserved at ${HOME_CORTEX}/db"
  else
    yellow "▸ Wiping ~/.cortex entirely..."
    rm -rf "$HOME_CORTEX"
    green "  removed"
  fi
else
  gray "  ~/.cortex doesn't exist — skipping"
fi

# 5. Reinstall (build → pack → install)
if [ "$DO_INSTALL" = true ]; then
  cyan "── Rebuilding & reinstalling ──────────────────────────"
  cd "$REPO_DIR"

  yellow "▸ Building bundle..."
  npm run build > /dev/null

  yellow "▸ Packing tarball..."
  TARBALL=$(npm pack 2>/dev/null | tail -1)
  gray "  $TARBALL"

  yellow "▸ Installing globally..."
  npm install -g "./${TARBALL}" > /dev/null
  green "  done"

  rm -f "$TARBALL"

  echo
  green "✓ Reset complete."
  echo
  cyan "Next steps:"
  echo "  cortex init      # configure provider, run migrations, register hooks"
  echo "  cortex doctor    # verify install"
else
  echo
  green "✓ Teardown complete (no reinstall)."
fi
