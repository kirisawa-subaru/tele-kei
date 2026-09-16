#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT/.telecodex/run"
CODEX_WRAPPER="$ROOT/telecodex-bin/codex"

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_check_repo_location
telecodex_prepare_runtime
echo "runtime: node=$TELECODEX_NODE_BIN $("$TELECODEX_NODE_BIN" --version)"

if [ ! -x "$CODEX_WRAPPER" ]; then
  echo "[codex-app-server] missing pinned Codex wrapper at $CODEX_WRAPPER" >&2
  exit 1
fi

mkdir -p "$RUN_DIR"
SOCKET_PATH="${CODEX_APP_SERVER_SOCKET:-$RUN_DIR/app-server.sock}"

set +e
telecodex_clear_stale_socket codex-app-server "$SOCKET_PATH" "$RUN_DIR"
socket_status=$?
set -e
if [ "$socket_status" -eq 2 ]; then
  exit 0
fi

echo "[codex-app-server] listening at $SOCKET_PATH" >&2
exec "$CODEX_WRAPPER" app-server --listen "unix://$SOCKET_PATH"
