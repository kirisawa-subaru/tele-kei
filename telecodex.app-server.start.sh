#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT/.telecodex/run"
ENV_FILE="$ROOT/.telecodex.env"
CODEX_WRAPPER="$ROOT/telecodex-bin/codex"

export PATH="$ROOT/telecodex-bin:$HOME/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:$PATH"
echo "runtime: node=$(command -v node) $(node --version 2>/dev/null || echo missing)"

set -a
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
set +a

if [ ! -x "$CODEX_WRAPPER" ]; then
  echo "[codex-app-server] missing pinned Codex wrapper at $CODEX_WRAPPER" >&2
  exit 1
fi

mkdir -p "$RUN_DIR"
SOCKET_PATH="${CODEX_APP_SERVER_SOCKET:-$RUN_DIR/app-server.sock}"

if [ -S "$SOCKET_PATH" ]; then
  if lsof -t -- "$SOCKET_PATH" >/dev/null 2>&1; then
    echo "[codex-app-server] already listening at $SOCKET_PATH" >&2
    exit 0
  fi
  case "$SOCKET_PATH" in
    "$RUN_DIR"/*.sock) ;;
    *)
      echo "[codex-app-server] stale socket outside managed run dir: $SOCKET_PATH" >&2
      exit 1
      ;;
  esac
  rm -f -- "$SOCKET_PATH"
  echo "[codex-app-server] removed stale socket $SOCKET_PATH" >&2
fi

echo "[codex-app-server] listening at $SOCKET_PATH" >&2
exec "$CODEX_WRAPPER" app-server --listen "unix://$SOCKET_PATH"
