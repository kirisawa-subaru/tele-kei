#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$ROOT/.vendor/telecodex"
ENV_FILE="$ROOT/.telecodex.env"
# Optional: colon-separated list of extra env files to source before
# .telecodex.env, for operators who already keep a Telegram token somewhere
# else. Empty by default; .telecodex.env is the only supported credential path.
EXTRA_ENV_FILES="${TELECODEX_EXTRA_ENV_FILES:-}"
PID_DIR="$ROOT/.telecodex/run"
PID_FILE="$PID_DIR/start.pid"
CODEX_WRAPPER="$ROOT/telecodex-bin/codex"

set -a
# Extra env files load first; the repo-local env file is loaded last and can
# override any of their values.
if [ -n "$EXTRA_ENV_FILES" ]; then
  while IFS= read -r extra_env; do
    [ -n "$extra_env" ] || continue
    if [ -f "$extra_env" ]; then
      # shellcheck disable=SC1090
      . "$extra_env"
    else
      echo "[telecodex] TELECODEX_EXTRA_ENV_FILES entry not found: $extra_env" >&2
    fi
  done <<EOF
$(printf '%s\n' "$EXTRA_ENV_FILES" | tr ':' '\n')
EOF
fi
set +a

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_check_repo_location
telecodex_prepare_runtime
echo "runtime: node=$TELECODEX_NODE_BIN $("$TELECODEX_NODE_BIN" --version)"

if [ ! -f "$SOURCE_DIR/dist/index.js" ]; then
  echo "[telecodex] missing built TeleCodex runtime at $SOURCE_DIR/dist/index.js" >&2
  echo "[telecodex] run ./telecodex.setup.sh first" >&2
  exit 1
fi

if [ ! -x "$CODEX_WRAPPER" ]; then
  echo "[telecodex] missing pinned Codex wrapper at $CODEX_WRAPPER" >&2
  echo "[telecodex] run ./telecodex.setup.sh first" >&2
  exit 1
fi

if [ -z "${TELEGRAM_ALLOWED_USER_IDS:-}" ] && [ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]; then
  export TELEGRAM_ALLOWED_USER_IDS="$TELEGRAM_ALLOWED_CHAT_IDS"
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_ALLOWED_USER_IDS:-}" ]; then
  echo "[telecodex] missing Telegram token or allowed user id" >&2
  echo "[telecodex] create $ENV_FILE (see .telecodex.env.example)" >&2
  exit 1
fi

# Chat defaults: preserve conversation and hide executor telemetry. The sandbox
# stays at workspace-write. Only never is supported: there is no approval UI.
# See SECURITY.md for the execution boundary.
export CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-workspace-write}"
export CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"
export TOOL_VERBOSITY="${TOOL_VERBOSITY:-none}"
export SHOW_TURN_TOKEN_USAGE="${SHOW_TURN_TOKEN_USAGE:-false}"
export ENABLE_TELEGRAM_REACTIONS="${ENABLE_TELEGRAM_REACTIONS:-false}"
export CODEX_BACKEND="${CODEX_BACKEND:-app-server}"
export CODEX_APP_SERVER_SOCKET="${CODEX_APP_SERVER_SOCKET:-$PID_DIR/app-server.sock}"
export CODEX_THREAD_IDLE_TIMEOUT_MS="${CODEX_THREAD_IDLE_TIMEOUT_MS:-3600000}"

cd "$ROOT"
CMD=("$TELECODEX_NODE_BIN" "$SOURCE_DIR/dist/index.js")

if [ -t 0 ] && [ -t 1 ]; then
  exec "${CMD[@]}" "$@"
fi

mkdir -p "$PID_DIR"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[telecodex] another wrapper alive (pid $(cat "$PID_FILE")); exiting." >&2
  exit 0
fi
echo $$ > "$PID_FILE"

cleanup() {
  rm -f "$PID_FILE"
  kill -- -$$ 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT EXIT

backoff=5
while true; do
  set +e
  "${CMD[@]}" "$@"
  rc=$?
  set -e
  echo "[$(date '+%F %T')] telecodex exited rc=$rc; restart in ${backoff}s" >&2
  sleep "$backoff"
  backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
done
