#!/bin/sh
# Sigil installer. Every way in lands on the same single install at ~/.sigil/app:
#
#   curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh
#   npm i -g @anmol-srv/sigil        (the npm `sigil` runs THIS script, bundled)
#   npx @anmol-srv/sigil             (same)
#
# One owner matters: the daemon + embedded DB are single-process, and two copies
# of Sigil fighting over ~/.sigil/db corrupt it. So npm never runs Sigil from its
# own directory (see src/lib/npm-door.js). This script clones the `release`
# branch into ~/.sigil/app, installs its runtime deps, and `sigil update` later
# fast-forwards that clone. CI publishes the same version to npm and the release
# branch on every release, so both channels always carry the latest Sigil.
#
# Environment overrides (mostly for testing):
#   SIGIL_BRANCH=master   track another branch      SIGIL_REPO=<url|path>  clone from elsewhere
#   SIGIL_NO_LAUNCH=1     install only, no setup    SIGIL_SKIP_TMUX=1      skip the optional tmux step
#
# Division of labour (deliberate — see init.js: "the terminal wizard and the
# browser wizard can never diverge"):
#   • THIS script detects only INSTALL-relevant host facts (OS, node, git) and
#     installs persistently: clone → deps → PATH.
#   • `sigil init` (Node, run at the end) does the rich DB + connector detection
#     and writes the launcher shims. We do NOT reimplement that here.
#
# POSIX sh only (this is piped to `sh`). No bashisms.

set -e

REPO="${SIGIL_REPO:-https://github.com/Anmol-Srv/sigil.git}"
BRANCH="${SIGIL_BRANCH:-release}"   # override: SIGIL_BRANCH=master curl ... | sh
SIGIL_HOME="${SIGIL_HOME:-$HOME/.sigil}"
APP_DIR="$SIGIL_HOME/app"
BIN_DIR="$HOME/.sigil/bin"
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
say "${DIM}Installing from git (${BRANCH})…${R}"
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

have git || die "Sigil installs from git but \`git\` was not found.
  Install git (https://git-scm.com or your package manager), then re-run this installer."

have node || die "Sigil needs Node.js $MIN_NODE_MAJOR+ but \`node\` was not found.
  Install it (https://nodejs.org or \`nvm install $MIN_NODE_MAJOR\`), then re-run this installer."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  die "Sigil needs Node.js $MIN_NODE_MAJOR+, but you have $(node -v 2>/dev/null).
  Upgrade Node (e.g. \`nvm install $MIN_NODE_MAJOR\`), then re-run this installer."
fi

have npm || die "Sigil needs \`npm\` to install its runtime dependencies (it ships with Node).
  Install Node from https://nodejs.org (npm is bundled), then re-run this installer."

step "Node $(node -v) + git detected."

# ── 2. clone (or update) the release branch ───────────────────────────────────
# Idempotent: a re-run of the installer acts as an update. We fetch + hard-reset
# rather than merge — the release branch is a derived, force-pushed artifact
# (CI commits the built dist/), so a 3-way merge would spuriously conflict.
mkdir -p "$SIGIL_HOME"
if [ -d "$APP_DIR/.git" ]; then
  step "Updating existing install at $APP_DIR…"
  git -C "$APP_DIR" fetch --depth 1 --quiet origin "$BRANCH" \
    || die "Could not fetch '$BRANCH' from $REPO — check your network."
  git -C "$APP_DIR" reset --hard --quiet FETCH_HEAD
else
  # A non-git dir here is a leftover from a different install method — replace it.
  [ -e "$APP_DIR" ] && { warn "Replacing non-git directory at $APP_DIR"; rm -rf "$APP_DIR"; }
  step "Cloning Sigil into $APP_DIR…"
  git clone --depth 1 --branch "$BRANCH" --quiet "$REPO" "$APP_DIR" \
    || die "Clone failed — is '$BRANCH' a valid branch of $REPO, and is the network up?"
fi

# ── 3. install runtime dependencies ───────────────────────────────────────────
# dist/ is already committed on the release branch (CI builds it), so there is no
# build step — we only need the runtime deps (the bundle keeps native/WASM/large
# packages external). --omit=dev skips everything bundled into dist/ at build time.
step "Installing runtime dependencies…"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error ) \
  || die "\`npm install\` failed in $APP_DIR. Re-run the installer, or cd there and inspect."

# ── 3b. evict a LEGACY global npm install ─────────────────────────────────────
# npm releases before 0.22 were full installs that ran their own daemon + PGlite
# version; two installs fighting over the single-process embedded DB
# (~/.sigil/db) is what corrupts it ("Aborted()"). Remove those. Newer npm
# releases only hand off to ~/.sigil/app, so they stay. Best-effort, never fatal.
NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || echo '')"
NPM_GLOBAL_PKG="$NPM_GLOBAL_ROOT/@anmol-srv/sigil"
if [ -n "$NPM_GLOBAL_ROOT" ] && [ -d "$NPM_GLOBAL_PKG" ]; then
  if ! node -e 'const v=require(process.argv[1]).version.split(".").map(Number);process.exit(v[0]>0||v[1]>=22?0:1)' "$NPM_GLOBAL_PKG/package.json" 2>/dev/null; then
    step "Removing an old global npm install of Sigil (it ran its own copy)…"
    npm rm -g @anmol-srv/sigil >/dev/null 2>&1 \
      || warn "Could not remove the old global npm install — remove it with: npm rm -g @anmol-srv/sigil"
  fi
fi

# ── 4. install launchers and put them on PATH ─────────────────────────────────
# Launchers must work before setup, including on headless installs and when the
# user chooses to connect no agents. Reuse the same renderer as sigil connect.
CLI="$APP_DIR/dist/cli.js"
[ -f "$CLI" ] || die "Install looks incomplete — $CLI is missing. Re-run the installer."
(
  cd "$APP_DIR" || exit 1
  node --input-type=module - <<'NODE'
import { writeLauncherShim } from './src/lib/clients/shim.js';
await writeLauncherShim();
NODE
) || die 'Could not install Sigil launchers. Re-run the installer.'

ensure_path() {
  rc="$1"
  marker="# added by sigil installer"
  if grep -qF "$marker" "$rc" 2>/dev/null; then return 0; fi
  {
    printf '\n%s\n' "$marker"
    printf '%s\n' 'export PATH="$HOME/.sigil/bin:$PATH"'
  } >> "$rc" || die "Could not add Sigil to PATH in $rc."
  step "Added ~/.sigil/bin to PATH in $rc"
}
# Create the active shell's rc file if missing. For bash login shells, use the
# first profile bash reads so an existing login configuration keeps running.
case "${SHELL:-}" in
  *zsh)  ensure_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
  *bash)
    ensure_path "$HOME/.bashrc"
    if [ -f "$HOME/.bash_profile" ]; then ensure_path "$HOME/.bash_profile"
    elif [ -f "$HOME/.bash_login" ]; then ensure_path "$HOME/.bash_login"
    else ensure_path "$HOME/.profile"
    fi ;;
  *) ensure_path "$HOME/.profile" ;;
esac
PATH="$BIN_DIR:$PATH"; export PATH

# ── 4b. optional: tmux for the managed-session engine ─────────────────────────
# Sigil's managed-session engine (SIGIL_MANAGED_SESSION=true) keeps a warm
# `claude`/`codex` worker alive inside tmux to avoid re-paying agentic cold-start
# per LLM call. tmux is OPTIONAL: without it the engine silently uses the
# one-shot path. Best-effort install on macOS/Linux; never fatal.
ensure_tmux() {
  [ "${SIGIL_SKIP_TMUX:-}" = "1" ] && return 0
  have tmux && return 0
  say "Installing tmux (optional — powers the warm managed-session engine)..."
  case "$OS" in
    Darwin) have brew && brew install tmux >/dev/null 2>&1 ;;
    Linux)
      if   have apt-get; then sudo apt-get install -y tmux >/dev/null 2>&1
      elif have dnf;     then sudo dnf install -y tmux     >/dev/null 2>&1
      elif have yum;     then sudo yum install -y tmux     >/dev/null 2>&1
      elif have pacman;  then sudo pacman -S --noconfirm tmux >/dev/null 2>&1
      elif have apk;     then sudo apk add tmux            >/dev/null 2>&1
      fi ;;
  esac
  if have tmux; then
    step "tmux ready: $(command -v tmux)"
  else
    warn "tmux not installed — the managed-session engine will use the one-shot path."
    warn "To enable it later: install tmux, then set SIGIL_MANAGED_SESSION=true."
  fi
}
ensure_tmux

VERSION="$(node -p 'require(process.argv[1]).version' "$APP_DIR/package.json" 2>/dev/null || echo '')"
step "Sigil ${VERSION} installed at $APP_DIR"

# The npm entry point runs this script, then launches Sigil itself.
[ "${SIGIL_NO_LAUNCH:-}" = "1" ] && exit 0

# ── 5. hand off to the SHARED Node first-run flow ─────────────────────────────
# Piped installs (curl … | sh) have the script on stdin, not the terminal — so
# reconnect to the controlling TTY. Test opening it: the device file can be
# readable in a headless shell even when this process has no controlling TTY.
if (exec 3</dev/tty) 2>/dev/null; then
  say ""
  say "${B}Starting Sigil${R} — it will detect your database and AI clients next."
  say ""
  exec "$BIN_DIR/sigil" < /dev/tty
else
  say "Sigil installed. To configure it from an interactive terminal, run:"
  say "  ${B}\"$BIN_DIR/sigil\" init${R}"
fi
