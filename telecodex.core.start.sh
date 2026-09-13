#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$ROOT/.vendor/telecodex"
ENV_FILE="$ROOT/.telecodex.env"
CODEX_WRAPPER="$ROOT/telecodex-bin/codex"
RUN_DIR="$ROOT/.telecodex/run"

export PATH="$ROOT/telecodex-bin:$HOME/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:$PATH"
if [ ! -f "$SOURCE_DIR/dist/core-index.js" ]; then
  echo "[telecodex-core] missing built runtime; run ./telecodex.setup.sh" >&2
  exit 1
fi
if [ ! -x "$CODEX_WRAPPER" ]; then
  echo "[telecodex-core] missing pinned Codex wrapper; run ./telecodex.setup.sh" >&2
  exit 1
fi

set -a
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
set +a

export CODEX_BACKEND="${CODEX_BACKEND:-app-server}"
export CODEX_APP_SERVER_SOCKET="${CODEX_APP_SERVER_SOCKET:-$RUN_DIR/app-server.sock}"
export TELECODEX_CORE_SOCKET="${TELECODEX_CORE_SOCKET:-$RUN_DIR/core.sock}"
export TELECODEX_CONTROL_SOCKET="${TELECODEX_CONTROL_SOCKET:-$RUN_DIR/control.sock}"
export CODEX_THREAD_IDLE_TIMEOUT_MS="${CODEX_THREAD_IDLE_TIMEOUT_MS:-3600000}"
# Sandbox stays at the Codex default; see SECURITY.md before widening it.
export CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-workspace-write}"
export CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-on-request}"

# A SIGKILL, crash, or host shutdown can leave filesystem socket nodes behind.
# Node cannot bind over them, so remove only unowned sockets inside our private
# run directory. A held socket means another core is alive; leave it untouched.
for socket_path in "$TELECODEX_CORE_SOCKET" "$TELECODEX_CONTROL_SOCKET"; do
  if [ ! -S "$socket_path" ]; then
    continue
  fi
  if lsof -t -- "$socket_path" >/dev/null 2>&1; then
    echo "[telecodex-core] already listening at $socket_path" >&2
    exit 0
  fi
  case "$socket_path" in
    "$RUN_DIR"/*.sock) ;;
    *)
      echo "[telecodex-core] stale socket outside managed run dir: $socket_path" >&2
      exit 1
      ;;
  esac
  rm -f -- "$socket_path"
  echo "[telecodex-core] removed stale socket $socket_path" >&2
done

cd "$ROOT"
exec node "$SOURCE_DIR/dist/core-index.js"
