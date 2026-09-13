#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$ROOT/.vendor/telecodex"
NPM_CACHE_DIR="${NPM_CONFIG_CACHE:-$ROOT/.telecodex/npm-cache}"
TRIGGER_SCRIPT="$ROOT/telegram-active/scripts/bind-current-thread.mjs"
TRIGGER_LINK="${TELEGRAM_ACTIVE_BIN:-/opt/homebrew/bin/telegram-active}"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"

if [ ! -f "$SOURCE_DIR/package.json" ]; then
  echo "[telecodex] tracked source is missing at $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$NPM_CACHE_DIR"

cd "$SOURCE_DIR"
npm install --cache "$NPM_CACHE_DIR"
npm run build

"$ROOT/telecodex.pin-codex.sh"

if [ -f "$TRIGGER_SCRIPT" ]; then
  chmod 755 "$TRIGGER_SCRIPT"
  trigger_dir="$(dirname "$TRIGGER_LINK")"
  if [ -L "$TRIGGER_LINK" ]; then
    if [ "$(readlink "$TRIGGER_LINK")" != "$TRIGGER_SCRIPT" ]; then
      echo "[telecodex] not replacing existing trigger symlink: $TRIGGER_LINK" >&2
    fi
  elif [ -e "$TRIGGER_LINK" ]; then
    echo "[telecodex] not replacing existing trigger command: $TRIGGER_LINK" >&2
  elif [ -d "$trigger_dir" ] && [ -w "$trigger_dir" ]; then
    ln -s "$TRIGGER_SCRIPT" "$TRIGGER_LINK"
    echo "Installed CLI trigger: $TRIGGER_LINK"
  else
    echo "[telecodex] trigger directory is not writable; run with TELEGRAM_ACTIVE_BIN set to a writable PATH location" >&2
  fi
fi

echo
echo "TeleCodex is built from tracked source at:"
echo "  $SOURCE_DIR"
echo
echo "Next:"
echo "  ./telecodex.app-server.start.sh"
echo "  ./telecodex.core.start.sh"
echo "  ./telecodex.worker.start.sh main"
echo "  In Codex CLI: !telegram-active"
echo
echo "Optional overrides:"
echo "  cp .telecodex.env.example .telecodex.env"
