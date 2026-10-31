#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUN_USER="${SUDO_USER:-${USER}}"
STATE_DIR="/var/lib/crypto-signal-bot"
ENV_FILE="/etc/crypto-signal-bot.env"
UNIT_NAME="crypto-signal-bot.service"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Install the bot as a systemd service.

Usage:
  sudo ./deploy/install-systemd.sh [options]

Options:
  --dry-run              Print the generated unit without changing the system
  --app-dir PATH         Project directory (default: parent of this script)
  --user NAME            Service account (default: $SUDO_USER or $USER)
  --state-dir PATH       Writable state/log directory (default: /var/lib/crypto-signal-bot)
  --env-file PATH        Environment file (default: /etc/crypto-signal-bot.env)
  -h, --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --app-dir) APP_DIR="$(cd -- "$2" && pwd)"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "User does not exist: $RUN_USER" >&2
  exit 1
fi
if [[ "$RUN_USER" == "root" && "$DRY_RUN" -eq 0 ]]; then
  echo "Warning: the service would run as root. Pass --user <name> to use an unprivileged account." >&2
fi
RUN_GROUP="$(id -gn "$RUN_USER")"

if [[ ! -f "$APP_DIR/bot.py" ]]; then
  echo "bot.py not found in $APP_DIR" >&2
  exit 1
fi

if [[ -x "$APP_DIR/.venv/bin/python" ]]; then
  PYTHON="$APP_DIR/.venv/bin/python"
else
  PYTHON="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON" ]]; then
  echo "python3 was not found; create a virtualenv or install Python 3.10+." >&2
  exit 1
fi
if [[ "$DRY_RUN" -eq 0 ]] && ! "$PYTHON" -c 'import requests' >/dev/null 2>&1; then
  echo "The selected Python cannot import requests: $PYTHON" >&2
  echo "Install dependencies first:" >&2
  echo "  $PYTHON -m pip install -r $APP_DIR/requirements.txt" >&2
  exit 1
fi

render_unit() {
  sed \
    -e "s|@APP_DIR@|$APP_DIR|g" \
    -e "s|@RUN_USER@|$RUN_USER|g" \
    -e "s|@RUN_GROUP@|$RUN_GROUP|g" \
    -e "s|@STATE_DIR@|$STATE_DIR|g" \
    -e "s|@ENV_FILE@|$ENV_FILE|g" \
    -e "s|@PYTHON@|$PYTHON|g" \
    "$SCRIPT_DIR/crypto-signal-bot.service"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "# Generated unit (dry run, nothing installed)"
  render_unit
  echo
  echo "# Would create $STATE_DIR and $UNIT_PATH, then enable and start $UNIT_NAME."
  exit 0
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found; this installer requires systemd." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$APP_DIR/config.example.env" "$ENV_FILE"
  echo "Created $ENV_FILE from config.example.env."
  echo "Edit it with your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then rerun this installer."
  exit 1
fi
chmod 0600 "$ENV_FILE"

install -d -m 0700 -o "$RUN_USER" -g "$RUN_GROUP" "$STATE_DIR"
chown "$RUN_USER:$RUN_GROUP" "$STATE_DIR"
chmod 0700 "$STATE_DIR"

TEMPORARY="$(mktemp)"
trap 'rm -f "$TEMPORARY"' EXIT
render_unit > "$TEMPORARY"
install -m 0644 "$TEMPORARY" "$UNIT_PATH"

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

echo "Installed and started $UNIT_NAME."
echo "Status:  systemctl status $UNIT_NAME"
echo "Logs:    journalctl -u $UNIT_NAME -f"
echo "State:   $STATE_DIR"
