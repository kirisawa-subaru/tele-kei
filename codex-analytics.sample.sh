#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_prepare_runtime

if [ ! -f "$ROOT/tools/codex_rate_limit_snapshot.mjs" ]; then
  echo "[codex-analytics] rate-limit collector script is missing" >&2
  exit 1
fi

if [ -z "${CODEX_BIN:-}" ]; then
  if [ -x "$ROOT/telecodex-bin/codex" ]; then
    CODEX_BIN="$ROOT/telecodex-bin/codex"
  else
    CODEX_BIN="$(command -v codex || true)"
  fi
fi
if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
  echo "[codex-analytics] Codex CLI is not available" >&2
  exit 1
fi
export CODEX_BIN

cd "$ROOT"
exec "$TELECODEX_NODE_BIN" tools/codex_rate_limit_snapshot.mjs "$@"

