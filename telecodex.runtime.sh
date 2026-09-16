#!/usr/bin/env bash
# TeleCodex runtime resolution. This file is sourced by every entrypoint and is
# never executed directly.
#
# Nothing in this repository may hardcode one machine's Node or Codex layout.
# Every lookup here follows the same order: an explicit environment override
# first, then a probe of the common install locations, then whatever is already
# on PATH.
#
# Supported platforms: macOS and Linux (including WSL2). Native Windows is not
# supported; see docs/platforms.md.
#
# Environment:
#   TELECODEX_NODE_BIN              absolute path to the node executable to use
#   TELECODEX_NODE_VERSION          preferred version, e.g. v24.14.1
#                                   (default: the contents of .nvmrc)
#   TELECODEX_REQUIRE_PINNED_NODE   1 = fail instead of falling back to another
#                                   installed Node
#   TELECODEX_MIN_NODE_MAJOR        minimum acceptable major version (default 22,
#                                   matching .vendor/telecodex/package.json)
#   TELECODEX_CODEX_BIN             absolute path to an existing codex executable;
#                                   bypasses the repo-local pin entirely
#   TELECODEX_PIN_ROOT              where the frozen Codex snapshot lives
#                                   (default <repo>/.vendor/codex)
#   TELECODEX_PINNED_CODEX_VERSION  Codex CLI version for the pin
#   TELECODEX_ALLOW_DRVFS           1 = skip the WSL /mnt/<drive> refusal

if [ -n "${TELECODEX_RUNTIME_LOADED:-}" ]; then
  return 0
fi
TELECODEX_RUNTIME_LOADED=1

TELECODEX_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${TELECODEX_ROOT:=$TELECODEX_RUNTIME_DIR}"
export TELECODEX_ROOT
# Functions read this, not TELECODEX_ROOT: `TELECODEX_ROOT=x . lib.sh` binds the
# variable only for the duration of the `.` builtin, so a caller using that form
# would leave every later function call with an empty root.
TELECODEX_ROOT_DIR="$TELECODEX_ROOT"

# Load this checkout's configuration before computing defaults or finding Node.
# Child wrappers inherit the effective configuration (including worker-specific
# overrides); re-sourcing the root file there would overwrite those overrides.
telecodex_load_repo_config() {
  [ "${TELECODEX_CONFIG_ROOT:-}" != "$TELECODEX_ROOT_DIR" ] || return 0
  local restore_allexport=0
  case $- in *a*) ;; *) restore_allexport=1 ;; esac
  set -a
  if [ -f "$TELECODEX_ROOT_DIR/.telecodex.env" ]; then
    # shellcheck disable=SC1090
    . "$TELECODEX_ROOT_DIR/.telecodex.env"
  fi
  if [ "$restore_allexport" -eq 1 ]; then set +a; fi
  export TELECODEX_CONFIG_ROOT="$TELECODEX_ROOT_DIR"
}
telecodex_load_repo_config

: "${TELECODEX_MIN_NODE_MAJOR:=22}"
: "${TELECODEX_PINNED_CODEX_VERSION:=0.153.4}"
: "${TELECODEX_PIN_ROOT:=$TELECODEX_ROOT_DIR/.vendor/codex}"

telecodex_log() {
  printf '[telecodex] %s\n' "$*" >&2
}

telecodex_die() {
  printf '[telecodex] %s\n' "$*" >&2
  exit 1
}

telecodex_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin\n' ;;
    Linux) printf 'linux\n' ;;
    *) printf 'other\n' ;;
  esac
}

telecodex_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64\n' ;;
    arm64 | aarch64) printf 'arm64\n' ;;
    *) uname -m ;;
  esac
}

telecodex_is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
  if [ -r /proc/sys/kernel/osrelease ] &&
    grep -qi 'microsoft' /proc/sys/kernel/osrelease 2>/dev/null; then
    return 0
  fi
  return 1
}

# WSL2 mounts Windows drives through DrvFs, which does not enforce Unix
# permission bits and does not give SQLite a working WAL. Both assumptions are
# load bearing: `chmod 0600` on the IPC sockets is the only access control in
# the system (SECURITY.md), and the state ledger is a hard dependency.
telecodex_check_repo_location() {
  [ "${TELECODEX_ALLOW_DRVFS:-0}" = "1" ] && return 0
  telecodex_is_wsl || return 0
  case "$TELECODEX_ROOT_DIR" in
    /mnt/[a-z]/* | /mnt/[A-Z]/*)
      telecodex_log "refusing to run from a Windows drive mount: $TELECODEX_ROOT_DIR"
      telecodex_log "DrvFs ignores the socket permission bits that are this system's"
      telecodex_log "only access control, and breaks SQLite WAL. Move the checkout to"
      telecodex_log "the Linux filesystem, e.g. ~/telecodex-oss. See docs/platforms.md."
      telecodex_log "Set TELECODEX_ALLOW_DRVFS=1 only if you understand both failures."
      exit 1
      ;;
  esac
}

telecodex_path_prepend() {
  local dir=$1
  [ -n "$dir" ] || return 0
  [ -d "$dir" ] || return 0
  case ":${PATH:-}:" in
    *":$dir:"*) return 0 ;;
  esac
  PATH="$dir:${PATH:-}"
  export PATH
}

telecodex_preferred_node_version() {
  if [ -n "${TELECODEX_NODE_VERSION:-}" ]; then
    printf '%s\n' "$TELECODEX_NODE_VERSION"
    return 0
  fi
  if [ -f "$TELECODEX_ROOT_DIR/.nvmrc" ]; then
    tr -d ' \t\r' <"$TELECODEX_ROOT_DIR/.nvmrc" | grep -v '^$' | head -n 1
  fi
}

telecodex_node_major() {
  local bin=$1
  [ -x "$bin" ] || return 1
  "$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

telecodex_node_acceptable() {
  local bin=$1 major
  major="$(telecodex_node_major "$bin")" || return 1
  [ -n "$major" ] || return 1
  [ "$major" -ge "$TELECODEX_MIN_NODE_MAJOR" ] 2>/dev/null
}

# Bin directories that could hold an exact Node version, across the version
# managers people actually use. Printed one per line; never word-split.
telecodex_node_candidate_dirs() {
  local version=$1
  local bare=${version#v}
  local os arch nvm_dir fnm_dir
  os="$(telecodex_os)"
  arch="$(telecodex_arch)"
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  printf '%s\n' \
    "$nvm_dir/versions/node/v$bare/bin" \
    "$fnm_dir/node-versions/v$bare/installation/bin" \
    "$HOME/.local/share/fnm/node-versions/v$bare/installation/bin" \
    "$HOME/.asdf/installs/nodejs/$bare/bin" \
    "$HOME/.volta/tools/image/node/$bare/bin" \
    "$HOME/n/versions/node/$bare/bin" \
    "$HOME/.local/opt/node-v$bare-$os-$arch/bin" \
    "$HOME/.local/opt/node-v$bare/bin" \
    "/usr/local/opt/node-v$bare-$os-$arch/bin" \
    "/opt/node-v$bare-$os-$arch/bin" \
    "/usr/local/n/versions/node/$bare/bin"
}

# Any installed Node, regardless of version, for the last-resort scan.
telecodex_node_installed_dirs() {
  local nvm_dir fnm_dir dir
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  for dir in \
    "$nvm_dir"/versions/node/*/bin \
    "$fnm_dir"/node-versions/*/installation/bin \
    "$HOME"/.local/opt/node-v*/bin \
    "$HOME"/.asdf/installs/nodejs/*/bin \
    "$HOME"/.volta/tools/image/node/*/bin \
    /opt/node-v*/bin \
    /usr/local/opt/node-v*/bin; do
    [ -d "$dir" ] || continue
    printf '%s\n' "$dir"
  done
}

telecodex_resolve_node() {
  local want dir

  if [ -n "${TELECODEX_NODE_BIN:-}" ]; then
    [ -x "$TELECODEX_NODE_BIN" ] ||
      telecodex_die "TELECODEX_NODE_BIN is not an executable: $TELECODEX_NODE_BIN"
    telecodex_path_prepend "$(cd "$(dirname "$TELECODEX_NODE_BIN")" && pwd)"
    export TELECODEX_NODE_BIN
    return 0
  fi

  want="$(telecodex_preferred_node_version)"
  if [ -n "$want" ]; then
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      if telecodex_node_acceptable "$dir/node"; then
        TELECODEX_NODE_BIN="$dir/node"
        telecodex_path_prepend "$dir"
        export TELECODEX_NODE_BIN
        return 0
      fi
    done <<EOF
$(telecodex_node_candidate_dirs "$want")
EOF
  fi

  if [ "${TELECODEX_REQUIRE_PINNED_NODE:-0}" = "1" ]; then
    telecodex_die "Node $want not found and TELECODEX_REQUIRE_PINNED_NODE=1. Install it, or set TELECODEX_NODE_BIN."
  fi

  # Whatever the operator's shell already resolves, if it is new enough.
  local path_node
  path_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$path_node" ] && telecodex_node_acceptable "$path_node"; then
    TELECODEX_NODE_BIN="$path_node"
    export TELECODEX_NODE_BIN
    [ -n "$want" ] && telecodex_log "Node $want not installed; using $path_node ($("$path_node" --version))"
    return 0
  fi

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if telecodex_node_acceptable "$dir/node"; then
      TELECODEX_NODE_BIN="$dir/node"
      telecodex_path_prepend "$dir"
      export TELECODEX_NODE_BIN
      telecodex_log "using $TELECODEX_NODE_BIN ($("$TELECODEX_NODE_BIN" --version))"
      return 0
    fi
  done <<EOF
$(telecodex_node_installed_dirs)
EOF

  telecodex_log "no Node >= $TELECODEX_MIN_NODE_MAJOR found."
  telecodex_log "Install Node ${want:-22+}, or point TELECODEX_NODE_BIN at one."
  telecodex_log "Searched: PATH, nvm, fnm, asdf, volta, n, ~/.local/opt, /opt."
  exit 1
}

# Prepend PATH entries and resolve Node. Callers that only need PATH hygiene
# (no Node) should not use this.
telecodex_prepare_runtime() {
  if [ "$(telecodex_os)" = "darwin" ]; then
    telecodex_path_prepend /usr/local/bin
    telecodex_path_prepend /opt/homebrew/bin
  fi
  telecodex_resolve_node
  # Last, so the repo-local Codex shim always wins over anything else named
  # `codex` on PATH.
  telecodex_path_prepend "$TELECODEX_ROOT_DIR/telecodex-bin"
}

telecodex_pin_dir() {
  printf '%s\n' "$TELECODEX_PIN_ROOT/codex-cli-$TELECODEX_PINNED_CODEX_VERSION"
}

# Entry script for the pinned Codex CLI, if the pin exists. Two layouts are
# accepted: the npm install prefix written by telecodex.pin-codex.sh, and the
# older flat snapshot of a globally installed package.
telecodex_pin_codex_js() {
  local pin
  if [ -n "${TELECODEX_PINNED_CODEX_JS:-}" ]; then
    printf '%s\n' "$TELECODEX_PINNED_CODEX_JS"
    return 0
  fi
  pin="$(telecodex_pin_dir)"
  if [ -f "$pin/node_modules/@openai/codex/bin/codex.js" ]; then
    printf '%s\n' "$pin/node_modules/@openai/codex/bin/codex.js"
    return 0
  fi
  if [ -f "$pin/bin/codex.js" ]; then
    printf '%s\n' "$pin/bin/codex.js"
    return 0
  fi
  return 1
}

# The Node frozen alongside the pin, if telecodex.pin-codex.sh captured one.
telecodex_pin_node_bin() {
  local dir
  if [ -n "${TELECODEX_PINNED_NODE_BIN:-}" ] && [ -x "${TELECODEX_PINNED_NODE_BIN}" ]; then
    printf '%s\n' "$TELECODEX_PINNED_NODE_BIN"
    return 0
  fi
  for dir in "$TELECODEX_PIN_ROOT"/node-*/bin; do
    [ -x "$dir/node" ] || continue
    printf '%s\n' "$dir/node"
    return 0
  done
  return 1
}

# Is something listening on this Unix socket? `lsof` when available (no side
# effects), otherwise an actual connect attempt through Node, which needs no
# external tool at all.
telecodex_socket_in_use() {
  local path=$1
  [ -S "$path" ] || return 1
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -- "$path" >/dev/null 2>&1
    return $?
  fi
  [ -n "${TELECODEX_NODE_BIN:-}" ] || return 1
  "$TELECODEX_NODE_BIN" -e '
    const net = require("node:net");
    const socket = net.connect(process.argv[1]);
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("error", () => process.exit(1));
    setTimeout(() => { socket.destroy(); process.exit(1); }, 2000).unref();
  ' "$path" >/dev/null 2>&1
}

# Remove a socket node left behind by a SIGKILL or a host crash, but only
# inside our own run directory and only when nobody is listening.
telecodex_clear_stale_socket() {
  local tag=$1 socket_path=$2 run_dir=$3
  [ -S "$socket_path" ] || return 0
  if telecodex_socket_in_use "$socket_path"; then
    printf '[%s] already listening at %s\n' "$tag" "$socket_path" >&2
    return 2
  fi
  case "$socket_path" in
    "$run_dir"/*.sock) ;;
    *)
      printf '[%s] stale socket outside managed run dir: %s\n' "$tag" "$socket_path" >&2
      exit 1
      ;;
  esac
  rm -f -- "$socket_path"
  printf '[%s] removed stale socket %s\n' "$tag" "$socket_path" >&2
  return 0
}
