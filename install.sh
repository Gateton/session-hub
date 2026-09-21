#!/usr/bin/env bash
#
# session-hub installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/session-hub/main/install.sh | bash
#
# or, from a checkout:
#
#   ./install.sh
#
# This script only finds Node and the hub itself. Everything else (detecting the
# agents you have, asking which ones, installing, wiring hooks) happens in
# install.mjs, so behaviour is identical on every platform.

set -euo pipefail

MIN_MAJOR=22
MIN_MINOR=5

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  fail "session-hub needs Node ${MIN_MAJOR}.${MIN_MINOR}+, and no 'node' was found on PATH.
Install it first (https://nodejs.org, or your package manager: nvm install 22, brew install node, apt install nodejs)."
fi

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt "$MIN_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_MINOR" ]; }; then
  fail "session-hub needs Node ${MIN_MAJOR}.${MIN_MINOR}+ and found ${NODE_VERSION}.
It uses node:sqlite with FTS5, which is built into Node, so no other dependency is required."
fi

# When run through a pipe, $0 is a shell, not a path, so the directory of the
# script cannot be trusted. SESSION_HUB_SOURCE wins, then a sibling install.mjs,
# then whatever install.mjs resolves on its own (a clone from SESSION_HUB_REPO).
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "${SESSION_HUB_SOURCE:-}" ]; then
  INSTALLER="$SESSION_HUB_SOURCE/install.mjs"
elif [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/install.mjs" ]; then
  INSTALLER="$SELF_DIR/install.mjs"
else
  INSTALLER=""
fi

if [ -n "$INSTALLER" ]; then
  say "session-hub: node ${NODE_VERSION} found, running the installer"
  exec node "$INSTALLER" "$@"
fi

# Piped execution with no local copy: clone once, then run the same installer.
say "session-hub: node ${NODE_VERSION} found, fetching the repository"
REPO="${SESSION_HUB_REPO:-}"
if [ -z "$REPO" ]; then
  fail "This one-liner needs to know where the repository is:

  curl -fsSL <url>/install.sh | SESSION_HUB_REPO=https://github.com/<owner>/session-hub bash

or clone it yourself and run ./install.sh from inside the checkout."
fi

command -v git >/dev/null 2>&1 || fail "git is required to fetch session-hub. Install git, or clone the repository yourself and run ./install.sh."

TARGET="${SESSION_HUB_DIR:-$HOME/.session-hub/src}"
if [ -d "$TARGET/.git" ]; then
  say "updating $TARGET"
  git -C "$TARGET" pull --ff-only
else
  say "cloning into $TARGET"
  git clone --depth 1 "$REPO" "$TARGET"
fi

exec node "$TARGET/install.mjs" "$@"
