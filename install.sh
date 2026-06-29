#!/bin/sh
# Sigil installer — the blessed, persistent install path. Git IS the source of
# truth: there is no npm package. This clones the release branch and runs from it.
#
#   curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh
#
# Why git, not npm: pushing to the `release` branch is the release — no `npm
# publish`, no version bump to keep in sync. The installer drops a git clone at
# ~/.sigil/app, installs its runtime deps once, and `sigil update` later just
# fast-forwards that clone. (`npx`/`pnpx` were never viable anyway: they run from
# a throwaway cache the package manager deletes, silently breaking the daemon +
# hooks that are pinned to a path.)
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

REPO="https://github.com/Anmol-Srv/sigil.git"
BRANCH="${SIGIL_BRANCH:-release}"   # override: SIGIL_BRANCH=master curl ... | sh
SIGIL_HOME="${SIGIL_HOME:-$HOME/.sigil}"
APP_DIR="$SIGIL_HOME/app"
BIN_DIR="$SIGIL_HOME/bin"
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

# ── 4. put ~/.sigil/bin on PATH ───────────────────────────────────────────────
# `sigil init` writes the launcher shims into $BIN_DIR; that dir is the single
# interactive + harness entry point now (no npm global bin to lean on). Wire it
# into the user's shell rc so `sigil` resolves in new shells. Idempotent via a
# marker line. The current piped shell hands off by absolute path below, so it
# doesn't depend on this taking effect immediately.
mkdir -p "$BIN_DIR"
ensure_path() {
  rc="$1"
  marker="# added by sigil installer"
  [ -f "$rc" ] || return 0
  if grep -qF "$marker" "$rc" 2>/dev/null; then return 0; fi
  {
    printf '\n%s\n' "$marker"
    printf '%s\n' 'export PATH="$HOME/.sigil/bin:$PATH"'
  } >> "$rc"
  step "Added ~/.sigil/bin to PATH in $rc"
}
# Wire whichever rc files exist for the user's likely shells. POSIX `sh` reads
# none of these, so we target interactive shells (zsh/bash) explicitly.
case "${SHELL:-}" in
  *zsh)  ensure_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
  *bash) ensure_path "$HOME/.bashrc"; ensure_path "$HOME/.bash_profile" ;;
  *)     ensure_path "$HOME/.zshrc"; ensure_path "$HOME/.bashrc" ;;
esac
# Also a generic profile fallback so non-login edge cases still resolve it.
ensure_path "$HOME/.profile"
PATH="$BIN_DIR:$PATH"; export PATH

# ── 4b. optional: tmux for the managed-session engine ─────────────────────────
# Sigil's managed-session engine (SIGIL_MANAGED_SESSION=true) keeps a warm
# `claude`/`codex` worker alive inside tmux to avoid re-paying agentic cold-start
# per LLM call. tmux is OPTIONAL: without it the engine silently uses the
# one-shot path. Best-effort install on macOS/Linux; never fatal.
ensure_tmux() {
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

# ── 5. hand off to the SHARED Node first-run flow ─────────────────────────────
# Zero-arg `sigil` opens the browser dashboard (the marketed experience) and
# auto-falls back to the terminal `sigil init` wizard when headless — both drive
# the same step engine that does the rich DB + connector detection AND writes the
# launcher shims into ~/.sigil/bin. We invoke it by ABSOLUTE PATH (the shims don't
# exist yet on a first install), so this works before PATH is wired.
CLI="$APP_DIR/dist/cli.js"
[ -f "$CLI" ] || die "Install looks incomplete — $CLI is missing. Re-run the installer."

say ""
say "${B}Starting Sigil${R} — it will detect your database and AI clients next."
say ""
# Piped installs (curl … | sh) have the script on stdin, not the terminal — so
# reconnect to the controlling TTY for the interactive prompts / browser launch.
# When there's no TTY (CI / non-interactive), print the next step instead.
if [ -r /dev/tty ]; then
  exec node "$CLI" < /dev/tty
else
  say "Non-interactive shell — finish setup with: ${B}node $CLI init${R}"
  say "(or open a new shell so \`sigil\` is on PATH, then run: ${B}sigil init${R})"
fi
