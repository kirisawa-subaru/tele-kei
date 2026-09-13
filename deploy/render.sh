#!/usr/bin/env bash
# Render the supervisor templates for this checkout.
#
#   ./deploy/render.sh                       # bot key "main", auto-detected target
#   ./deploy/render.sh --bot-key ops         # a second worker unit
#   ./deploy/render.sh --target launchd --label-prefix com.example.telecodex
#
# Output goes to .telecodex/deploy/ (gitignored). Nothing outside the repository
# is written or loaded; the install commands are printed for you to run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET=""
BOT_KEY="main"
LABEL_PREFIX="com.example.telecodex"
OUT_DIR="$ROOT/.telecodex/deploy"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --bot-key) BOT_KEY="${2:-}"; shift 2 ;;
    --label-prefix) LABEL_PREFIX="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  case "$(uname -s)" in
    Darwin) TARGET=launchd ;;
    *) TARGET=systemd ;;
  esac
fi

if ! printf '%s' "$BOT_KEY" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$'; then
  echo "invalid bot key: $BOT_KEY (lowercase, starts with a letter)" >&2
  exit 2
fi

render() {
  sed \
    -e "s|__TELECODEX_ROOT__|$ROOT|g" \
    -e "s|__LABEL_PREFIX__|$LABEL_PREFIX|g" \
    -e "s|__BOT_KEY__|$BOT_KEY|g" \
    "$1" >"$2"
}

mkdir -p "$OUT_DIR"

case "$TARGET" in
  systemd)
    render "$ROOT/deploy/systemd/telecodex-app-server.service" "$OUT_DIR/telecodex-app-server.service"
    render "$ROOT/deploy/systemd/telecodex-core.service" "$OUT_DIR/telecodex-core.service"
    render "$ROOT/deploy/systemd/telecodex-worker@.service" "$OUT_DIR/telecodex-worker@.service"
    echo "Rendered systemd user units into $OUT_DIR"
    echo
    echo "Install:"
    echo "  mkdir -p ~/.config/systemd/user"
    echo "  cp $OUT_DIR/telecodex-*.service ~/.config/systemd/user/"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now telecodex-app-server telecodex-core telecodex-worker@$BOT_KEY"
    echo
    echo "Survive logout:"
    echo "  loginctl enable-linger \"\$USER\""
    echo
    echo "On WSL2, systemd exists only with [boot] systemd=true in /etc/wsl.conf."
    ;;
  launchd)
    render "$ROOT/deploy/launchd/telecodex.app-server.plist" "$OUT_DIR/$LABEL_PREFIX.app-server.plist"
    render "$ROOT/deploy/launchd/telecodex.core.plist" "$OUT_DIR/$LABEL_PREFIX.core.plist"
    render "$ROOT/deploy/launchd/telecodex.worker.plist" "$OUT_DIR/$LABEL_PREFIX.worker.$BOT_KEY.plist"
    echo "Rendered launchd agents into $OUT_DIR"
    echo
    echo "Install:"
    echo "  mkdir -p ~/Library/LaunchAgents \"$ROOT/.telecodex/logs\""
    echo "  cp $OUT_DIR/$LABEL_PREFIX.*.plist ~/Library/LaunchAgents/"
    echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL_PREFIX.app-server.plist"
    echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL_PREFIX.core.plist"
    echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL_PREFIX.worker.$BOT_KEY.plist"
    ;;
  *)
    echo "unknown target: $TARGET (expected systemd or launchd)" >&2
    exit 2
    ;;
esac
