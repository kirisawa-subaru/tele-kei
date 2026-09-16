#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$ROOT/.vendor/telecodex"
CODEX_WRAPPER="$ROOT/telecodex-bin/codex"
RUN_DIR="$ROOT/.telecodex/run"

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_check_repo_location
telecodex_prepare_runtime

if [ ! -f "$SOURCE_DIR/dist/core-index.js" ]; then
  echo "[telecodex-core] missing built runtime; run ./telecodex.setup.sh" >&2
  exit 1
fi
if [ ! -x "$CODEX_WRAPPER" ]; then
  echo "[telecodex-core] missing pinned Codex wrapper; run ./telecodex.setup.sh" >&2
  exit 1
fi

export CODEX_BACKEND="${CODEX_BACKEND:-app-server}"
export CODEX_APP_SERVER_SOCKET="${CODEX_APP_SERVER_SOCKET:-$RUN_DIR/app-server.sock}"
export TELECODEX_CORE_SOCKET="${TELECODEX_CORE_SOCKET:-$RUN_DIR/core.sock}"
export TELECODEX_CONTROL_SOCKET="${TELECODEX_CONTROL_SOCKET:-$RUN_DIR/control.sock}"
export CODEX_THREAD_IDLE_TIMEOUT_MS="${CODEX_THREAD_IDLE_TIMEOUT_MS:-3600000}"
# Sandbox stays at the Codex default; see SECURITY.md before widening it.
export CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-workspace-write}"
export CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"

# A SIGKILL, crash, or host shutdown can leave filesystem socket nodes behind.
# Node cannot bind over them, so remove only unowned sockets inside our private
# run directory. A held socket means another core is alive; leave it untouched.
for socket_path in "$TELECODEX_CORE_SOCKET" "$TELECODEX_CONTROL_SOCKET"; do
  set +e
  telecodex_clear_stale_socket telecodex-core "$socket_path" "$RUN_DIR"
  socket_status=$?
  set -e
  if [ "$socket_status" -eq 2 ]; then
    exit 0
  fi
done

cd "$ROOT"
exec "$TELECODEX_NODE_BIN" "$SOURCE_DIR/dist/core-index.js"
