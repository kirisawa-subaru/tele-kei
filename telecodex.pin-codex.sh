#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENDOR_ROOT="$ROOT/.vendor"
PINNED_CODEX_VERSION="${TELECODEX_PINNED_CODEX_VERSION:-0.153.4}"
PINNED_NODE_VERSION="${TELECODEX_PINNED_NODE_VERSION:-v24.14.1}"
PINNED_CODEX_SOURCE_PACKAGE="${TELECODEX_PINNED_CODEX_SOURCE_PACKAGE:-$HOME/.nvm/versions/node/$PINNED_NODE_VERSION/lib/node_modules/@openai/codex}"
PINNED_NODE_SOURCE_BIN="${TELECODEX_PINNED_NODE_SOURCE_BIN:-$HOME/.nvm/versions/node/$PINNED_NODE_VERSION/bin/node}"
PINNED_CODEX_ROOT="$VENDOR_ROOT/codex"
PINNED_CODEX_SNAPSHOT_DIR="$PINNED_CODEX_ROOT/codex-cli-$PINNED_CODEX_VERSION"
PINNED_NODE_SNAPSHOT_BIN_DIR="$PINNED_CODEX_ROOT/node-$PINNED_NODE_VERSION/bin"

if [ ! -f "$PINNED_CODEX_SOURCE_PACKAGE/package.json" ]; then
  echo "[telecodex] missing pinned Codex package source: $PINNED_CODEX_SOURCE_PACKAGE" >&2
  exit 1
fi

if [ ! -x "$PINNED_NODE_SOURCE_BIN" ]; then
  echo "[telecodex] missing pinned Node source binary: $PINNED_NODE_SOURCE_BIN" >&2
  exit 1
fi

pinned_source_version="$(awk -F'\"' '$2 == "version" { print $4; exit }' "$PINNED_CODEX_SOURCE_PACKAGE/package.json")"
if [ "$pinned_source_version" != "$PINNED_CODEX_VERSION" ]; then
  echo "[telecodex] expected Codex $PINNED_CODEX_VERSION at $PINNED_CODEX_SOURCE_PACKAGE, found ${pinned_source_version:-unknown}" >&2
  exit 1
fi

mkdir -p "$PINNED_CODEX_SNAPSHOT_DIR" "$PINNED_NODE_SNAPSHOT_BIN_DIR"
rsync -a --delete "$PINNED_CODEX_SOURCE_PACKAGE/" "$PINNED_CODEX_SNAPSHOT_DIR/"
install -m 755 "$PINNED_NODE_SOURCE_BIN" "$PINNED_NODE_SNAPSHOT_BIN_DIR/node"

if ! "$ROOT/telecodex-bin/codex" --version >/dev/null 2>&1; then
  echo "[telecodex] pinned Codex wrapper failed verification" >&2
  exit 1
fi

echo "Pinned Codex snapshot:"
echo "  $ROOT/telecodex-bin/codex -> codex-cli $PINNED_CODEX_VERSION (node $PINNED_NODE_VERSION)"
