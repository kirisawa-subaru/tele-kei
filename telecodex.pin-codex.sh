#!/usr/bin/env bash
# Install the pinned Codex CLI into .vendor/codex/ (gitignored).
#
# The services must never resolve `codex` from a mutable PATH: a background
# upgrade of a globally installed CLI would silently change the protocol the
# bridge speaks. So one exact version is installed into the repository and
# telecodex-bin/codex always runs that copy.
#
# Three ways to supply it, in priority order:
#
#   1. TELECODEX_CODEX_BIN=/path/to/codex
#      You already have the right version somewhere and want to use it as is.
#      Nothing is installed; this script only verifies the version.
#
#   2. TELECODEX_PINNED_CODEX_SOURCE_PACKAGE=/path/to/node_modules/@openai/codex
#      Copy an existing local install. Useful offline, or when a machine is
#      already on the pinned version.
#
#   3. (default) npm install @openai/codex@<version> into .vendor/codex/.
#      @openai/codex is a public npm package; this needs network but no
#      account, no global install and no administrator rights.
#
# Override the version with TELECODEX_PINNED_CODEX_VERSION.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

TELECODEX_ROOT="$ROOT"
# shellcheck source=telecodex.runtime.sh
. "$ROOT/telecodex.runtime.sh"
telecodex_prepare_runtime

PINNED_CODEX_VERSION="$TELECODEX_PINNED_CODEX_VERSION"
PIN_DIR="$(telecodex_pin_dir)"
WRAPPER="$ROOT/telecodex-bin/codex"

verify_wrapper() {
  local reported
  if ! reported="$("$WRAPPER" --version 2>&1)"; then
    echo "[telecodex] pinned Codex wrapper failed to run:" >&2
    echo "$reported" >&2
    exit 1
  fi
  case "$reported" in
    *"$PINNED_CODEX_VERSION"*) ;;
    *)
      echo "[telecodex] expected Codex $PINNED_CODEX_VERSION, wrapper reports: $reported" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$reported"
}

if [ -n "${TELECODEX_CODEX_BIN:-}" ]; then
  [ -x "$TELECODEX_CODEX_BIN" ] ||
    telecodex_die "TELECODEX_CODEX_BIN is not an executable: $TELECODEX_CODEX_BIN"
  echo "Using the Codex CLI at $TELECODEX_CODEX_BIN (no repo-local pin installed)."
  echo "  $(verify_wrapper)"
  echo "Keep TELECODEX_CODEX_BIN exported for every TeleCodex process, or put it"
  echo "in .telecodex.env, otherwise the services will look for the pin instead."
  exit 0
fi

platform_package() {
  local os arch
  os="$(telecodex_os)"
  arch="$(telecodex_arch)"
  case "$os-$arch" in
    darwin-arm64) printf '@openai/codex-darwin-arm64\n' ;;
    darwin-x64) printf '@openai/codex-darwin-x64\n' ;;
    linux-arm64) printf '@openai/codex-linux-arm64\n' ;;
    linux-x64) printf '@openai/codex-linux-x64\n' ;;
    *) return 1 ;;
  esac
}

PLATFORM_PACKAGE="$(platform_package)" ||
  telecodex_die "no Codex CLI build for $(telecodex_os)/$(telecodex_arch)"

install_from_local_package() {
  local source_package=$1
  local source_parent target_modules platform_source
  [ -f "$source_package/package.json" ] ||
    telecodex_die "not a package directory: $source_package"

  local source_version
  source_version="$("$TELECODEX_NODE_BIN" -p \
    "require('$source_package/package.json').version" 2>/dev/null || true)"
  if [ "$source_version" != "$PINNED_CODEX_VERSION" ]; then
    telecodex_die "expected Codex $PINNED_CODEX_VERSION at $source_package, found ${source_version:-unknown}"
  fi

  target_modules="$PIN_DIR/node_modules/@openai"
  rm -rf -- "$PIN_DIR"
  mkdir -p "$target_modules"
  cp -R "$source_package" "$target_modules/codex"

  # bin/codex.js resolves the native binary out of a sibling platform package,
  # so that one has to come along too or the CLI cannot start.
  source_parent="$(cd "$source_package/../.." && pwd)"
  platform_source="$source_parent/${PLATFORM_PACKAGE}"
  if [ -d "$platform_source" ]; then
    cp -R "$platform_source" "$target_modules/$(basename "$PLATFORM_PACKAGE")"
  elif [ -d "$source_package/node_modules/$PLATFORM_PACKAGE" ]; then
    cp -R "$source_package/node_modules/$PLATFORM_PACKAGE" \
      "$target_modules/$(basename "$PLATFORM_PACKAGE")"
  else
    telecodex_die "could not find $PLATFORM_PACKAGE next to $source_package"
  fi
}

install_from_npm() {
  local npm_bin
  npm_bin="$(dirname "$TELECODEX_NODE_BIN")/npm"
  [ -x "$npm_bin" ] || npm_bin="$(command -v npm || true)"
  [ -n "$npm_bin" ] || telecodex_die "npm not found; install Node with npm, or use TELECODEX_PINNED_CODEX_SOURCE_PACKAGE"

  rm -rf -- "$PIN_DIR"
  mkdir -p "$PIN_DIR"
  # A private prefix, not a global install: nothing outside this repository is
  # touched and no other project's Codex version changes.
  cat >"$PIN_DIR/package.json" <<JSON
{
  "name": "telecodex-pinned-codex",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "@openai/codex": "$PINNED_CODEX_VERSION"
  }
}
JSON
  (cd "$PIN_DIR" && "$npm_bin" install --no-audit --no-fund --loglevel=error)
}

if [ -n "${TELECODEX_PINNED_CODEX_SOURCE_PACKAGE:-}" ]; then
  echo "Pinning Codex $PINNED_CODEX_VERSION from $TELECODEX_PINNED_CODEX_SOURCE_PACKAGE"
  install_from_local_package "$TELECODEX_PINNED_CODEX_SOURCE_PACKAGE"
else
  echo "Installing Codex $PINNED_CODEX_VERSION from npm into $PIN_DIR"
  install_from_npm
fi

echo "Pinned Codex snapshot:"
echo "  $WRAPPER -> $(verify_wrapper)"
