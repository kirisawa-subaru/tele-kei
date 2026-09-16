#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$ROOT/.vendor/telecodex"
TRIGGER_SCRIPT="$ROOT/telegram-active/scripts/bind-current-thread.mjs"
# Where to symlink the `telegram-active` CLI trigger. ~/.local/bin needs no
# administrator rights on either macOS or Linux; override for any other PATH
# directory you own.

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_check_repo_location
telecodex_prepare_runtime
NPM_CACHE_DIR="${NPM_CONFIG_CACHE:-$ROOT/.telecodex/npm-cache}"
TRIGGER_LINK="${TELEGRAM_ACTIVE_BIN:-$HOME/.local/bin/telegram-active}"

if [ ! -f "$SOURCE_DIR/package.json" ]; then
  echo "[telecodex] tracked source is missing at $SOURCE_DIR" >&2
  exit 1
fi

NPM_BIN="$(dirname "$TELECODEX_NODE_BIN")/npm"
if [ ! -x "$NPM_BIN" ]; then
  NPM_BIN="$(command -v npm || true)"
fi
if [ -z "$NPM_BIN" ]; then
  echo "[telecodex] npm not found next to $TELECODEX_NODE_BIN or on PATH" >&2
  exit 1
fi

echo "[telecodex] node $("$TELECODEX_NODE_BIN" --version) at $TELECODEX_NODE_BIN"

mkdir -p "$NPM_CACHE_DIR"

cd "$SOURCE_DIR"
"$NPM_BIN" install --cache "$NPM_CACHE_DIR"
"$NPM_BIN" run build

"$ROOT/telecodex.pin-codex.sh"

if [ -f "$TRIGGER_SCRIPT" ]; then
  chmod 755 "$TRIGGER_SCRIPT"
  trigger_dir="$(dirname "$TRIGGER_LINK")"
  if [ ! -d "$trigger_dir" ] && [ "$trigger_dir" = "$HOME/.local/bin" ]; then
    mkdir -p "$trigger_dir"
  fi
  if [ -L "$TRIGGER_LINK" ]; then
    if [ "$(readlink "$TRIGGER_LINK")" != "$TRIGGER_SCRIPT" ]; then
      echo "[telecodex] not replacing existing trigger symlink: $TRIGGER_LINK" >&2
    fi
  elif [ -e "$TRIGGER_LINK" ]; then
    echo "[telecodex] not replacing existing trigger command: $TRIGGER_LINK" >&2
  elif [ -d "$trigger_dir" ] && [ -w "$trigger_dir" ]; then
    ln -s "$TRIGGER_SCRIPT" "$TRIGGER_LINK"
    echo "Installed CLI trigger: $TRIGGER_LINK"
    case ":${PATH:-}:" in
      *":$trigger_dir:"*) ;;
      *) echo "[telecodex] note: $trigger_dir is not on your PATH" >&2 ;;
    esac
  else
    echo "[telecodex] trigger directory is not writable; rerun with TELEGRAM_ACTIVE_BIN set to a writable PATH location" >&2
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
