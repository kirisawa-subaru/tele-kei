#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
export PATH="$ROOT/telecodex-bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[codex-analytics] node is not available" >&2
  exit 1
fi
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
exec node tools/codex_daily_workspace_usage.mjs "$@"
