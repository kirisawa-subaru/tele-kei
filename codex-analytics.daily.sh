#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_prepare_runtime

if [ ! -f "$ROOT/tools/codex_daily_workspace_usage.mjs" ]; then
  echo "[codex-analytics] collector script is missing" >&2
  exit 1
fi

if [ -z "${CODEX_BIN:-}" ]; then
  if [ -x "$ROOT/telecodex-bin/codex" ]; then
    CODEX_BIN="$ROOT/telecodex-bin/codex"
  else
    CODEX_BIN="$(command -v codex || true)"
  fi
fi
if [ -n "$CODEX_BIN" ]; then
  export CODEX_BIN
fi

cd "$ROOT"
exec "$TELECODEX_NODE_BIN" tools/codex_daily_workspace_usage.mjs "$@"
