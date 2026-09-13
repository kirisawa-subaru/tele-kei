#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$ROOT/.vendor/telecodex"
BOT_KEY="${1:-${TELECODEX_BOT_KEY:-}}"
INSTANCE_ENV="$ROOT/.telecodex/instances/$BOT_KEY/bot.env"
REPO_ENV="$ROOT/.telecodex.env"
# The bot key that inherits .telecodex.env when it has no instance env of its
# own. Every additional bot must carry its own untracked instance env.
PRIMARY_BOT_KEY="${TELECODEX_PRIMARY_BOT_KEY:-main}"

if [[ ! "$BOT_KEY" =~ ^[a-z][a-z0-9_-]{0,31}$ ]]; then
  echo "Usage: telecodex.worker.start.sh BOT_KEY" >&2
  exit 2
fi

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_check_repo_location
telecodex_prepare_runtime

if [ ! -f "$SOURCE_DIR/dist/worker-index.js" ]; then
  echo "[telecodex-worker:$BOT_KEY] missing built runtime; run ./telecodex.setup.sh" >&2
  exit 1
fi

set -a
if [ "$BOT_KEY" = "$PRIMARY_BOT_KEY" ]; then
  # shellcheck disable=SC1090
  if [ -f "$REPO_ENV" ]; then . "$REPO_ENV"; fi
fi
if [ -f "$INSTANCE_ENV" ]; then
  # shellcheck disable=SC1090
  . "$INSTANCE_ENV"
fi
set +a

# Accept TELEGRAM_ALLOWED_CHAT_IDS as an alias: the worker authorizes Telegram
# users, but existing deployments often store the same allowlist under the
# chat-id name.
if [ -z "${TELEGRAM_ALLOWED_USER_IDS:-}" ] && [ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]; then
  export TELEGRAM_ALLOWED_USER_IDS="$TELEGRAM_ALLOWED_CHAT_IDS"
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_ALLOWED_USER_IDS:-}" ]; then
  echo "[telecodex-worker:$BOT_KEY] missing token or allowed user ids in $INSTANCE_ENV" >&2
  exit 1
fi

export TELECODEX_BOT_KEY="$BOT_KEY"
export TELECODEX_CORE_SOCKET="${TELECODEX_CORE_SOCKET:-$ROOT/.telecodex/run/core.sock}"
export TELECODEX_STATE_DB="${TELECODEX_STATE_DB:-$ROOT/.telecodex/state.sqlite}"
export TOOL_VERBOSITY="${TOOL_VERBOSITY:-none}"
export SHOW_TURN_TOKEN_USAGE="${SHOW_TURN_TOKEN_USAGE:-false}"
export ENABLE_TELEGRAM_REACTIONS="${ENABLE_TELEGRAM_REACTIONS:-false}"

# A worker must never be able to become an app-server writer accidentally.
unset CODEX_APP_SERVER_SOCKET

cd "$ROOT"
exec "$TELECODEX_NODE_BIN" "$SOURCE_DIR/dist/worker-index.js"
