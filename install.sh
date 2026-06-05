#!/bin/sh
# Sigil installer — the blessed, persistent install path.
#
#   curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh
#
# Why this exists: `npx`/`pnpx @anmol-srv/sigil` runs from a throwaway cache the
# package manager later deletes. Sigil is persistent infrastructure (a daemon +
# Claude Code hooks pinned to a path), so installing from a temp dir silently
# breaks memory. This script removes that decision from the user: it puts Sigil
# somewhere permanent and on PATH, then hands off to Sigil's own first-run flow.
#
# Division of labour (deliberate — see init.js: "the terminal wizard and the
# browser wizard can never diverge"):
#   • THIS script detects only INSTALL-relevant host facts (OS, node, package
#     manager, global-bin health) and installs persistently.
#   • `sigil init` (Node, already installed by then) does the rich DB + connector
#     detection. We do NOT reimplement that here — one detector, no drift.
#
# POSIX sh only (this is piped to `sh`). No bashisms.

set -e

PKG="@anmol-srv/sigil"
VERSION="${SIGIL_VERSION:-latest}"   # override: SIGIL_VERSION=0.18.3 curl ... | sh
MIN_NODE_MAJOR=20

# ── output helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; R="$(printf '\033[0m')"
  GREEN="$(printf '\033[32m')"; RED="$(printf '\033[31m')"; YEL="$(printf '\033[33m')"
else
  B=''; DIM=''; R=''; GREEN=''; RED=''; YEL=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$GREEN" "$R" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$R" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$R" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '%s\n' "${B}Sigil${R} — persistent memory for your AI agents"
say "${DIM}Installing $PKG ($VERSION)…${R}"
say ""

# ── 1. host detection (install-relevant ONLY) ─────────────────────────────────
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin|Linux) ;;  # Linux covers WSL (uname reports Linux inside WSL).
  MINGW*|MSYS*|CYGWIN*)
     warn "This looks like native Windows ($OS)."
     die "Sigil is unsupported on native Windows. Install it inside WSL (Windows Subsystem for Linux):
  https://learn.microsoft.com/windows/wsl/install" ;;
  *) warn "Unsupported/unknown OS '$OS'."
     die "Stopping — Sigil targets macOS, Linux, and Windows via WSL." ;;
esac

have node || die "Sigil needs Node.js $MIN_NODE_MAJOR+ but \`node\` was not found.
  Install it (https://nodejs.org or \`nvm install $MIN_NODE_MAJOR\`), then re-run this installer."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  die "Sigil needs Node.js $MIN_NODE_MAJOR+, but you have $(node -v 2>/dev/null).
  Upgrade Node (e.g. \`nvm install $MIN_NODE_MAJOR\`), then re-run this installer."
fi
step "Node $(node -v) detected."

# ── 2. install persistently ───────────────────────────────────────────────────
# Prefer npm: it ships with Node and its global bin is already on PATH. Fall back
# to pnpm only if npm is absent — and fix the "no global bin dir" pitfall (the
# PNPM_HOME error) automatically instead of dumping it on the user.
SUDO=''
install_with_npm() {
  prefix="$(npm prefix -g 2>/dev/null || true)"
  # System-node installs (e.g. /usr) need root to write node_modules; nvm/brew
  # installs are user-writable and must NOT use sudo.
  if [ -n "$prefix" ] && [ ! -w "$prefix" ] && [ ! -w "$prefix/lib/node_modules" ] 2>/dev/null; then
    if have sudo; then
      warn "Global npm dir ($prefix) needs root — using sudo for the install."
      SUDO='sudo'
    else
      die "Global npm dir ($prefix) is not writable and \`sudo\` is unavailable.
  Either fix permissions or use a user-level Node (nvm/fnm), then re-run."
    fi
  fi
  step "Installing with npm…"
  $SUDO npm install -g "$PKG@$VERSION"
}
install_with_pnpm() {
  # pnpm needs a configured global bin dir; `pnpm setup` creates it + PATH wiring.
  if ! pnpm bin -g >/dev/null 2>&1; then
    step "Configuring pnpm global bin dir (pnpm setup)…"
    pnpm setup >/dev/null 2>&1 || warn "\`pnpm setup\` reported an issue — continuing."
  fi
  step "Installing with pnpm…"
  pnpm add -g "$PKG@$VERSION"
  # `pnpm setup` wires PATH into the shell rc, NOT this piped sh — so without help
  # the post-install `have sigil` check + `exec sigil` handoff would fail for
  # pnpm-only users even though the install succeeded. Resolve pnpm's global bin
  # dir from the likely locations and prepend the one that actually holds the
  # freshly-installed `sigil`.
  for _d in "$(pnpm bin -g 2>/dev/null)" "$PNPM_HOME" "${XDG_DATA_HOME:-$HOME/.local/share}/pnpm" "$HOME/Library/pnpm"; do
    if [ -n "$_d" ] && [ -x "$_d/sigil" ]; then
      PATH="$_d:$PATH"; export PATH; break
    fi
  done
}

if have npm; then
  install_with_npm
elif have pnpm; then
  install_with_pnpm
else
  die "No package manager found. Install npm (bundled with Node) or pnpm, then re-run."
fi

# ── 3. verify it landed on PATH ───────────────────────────────────────────────
hash -r 2>/dev/null || true
if have sigil; then
  step "Installed: $(command -v sigil)"
else
  warn "Sigil installed, but \`sigil\` isn't on your PATH yet."
  warn "Add your global bin dir to PATH (open a new shell), then run: sigil init"
  exit 0
fi

# ── 4. hand off to the SHARED Node first-run flow ─────────────────────────────
# Zero-arg `sigil` opens the browser dashboard (the marketed experience) and
# auto-falls back to the terminal `sigil init` wizard when headless — both drive
# the same step engine that does the rich DB + connector detection. The
# ephemeral guard in that launch path stays as a backstop, but it can't fire now:
# we just installed persistently.
say ""
say "${B}Starting Sigil${R} — it will detect your database and AI clients next."
say ""
# Piped installs (curl … | sh) have the script on stdin, not the terminal — so
# reconnect to the controlling TTY for the interactive prompts / browser launch.
# When there's no TTY (CI / non-interactive), print the next step instead.
if [ -r /dev/tty ]; then
  exec sigil < /dev/tty
else
  say "Non-interactive shell — finish setup with: ${B}sigil init${R}"
fi
