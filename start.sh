#!/usr/bin/env bash
# Build the static preview and serve it in the foreground on PORT.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_DIR="$(pwd -P)"
PORT="${PORT:-3000}"
DIST="$PROJECT_DIR/dist"
WEB_DIR="${OPENCODE_WEB_DIR:-${RUNNER_TEMP:-/tmp}/omgithub-web}"

timed() {
  printf '[timing] %s\n' "$*"
  /usr/bin/time -p "$@"
}

log() {
  printf '[start] %s\n' "$*"
}

[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "PORT must be a number, got: $PORT" >&2; exit 1; }

log "Project: $PROJECT_DIR"
log "Port: $PORT"

# Install dependencies only when the project actually declares a Node build.
if [[ -f "$PROJECT_DIR/package.json" ]]; then
  if [[ -f "$PROJECT_DIR/package-lock.json" ]]; then
    timed npm ci --no-audit --no-fund
  else
    timed npm install --no-audit --no-fund
  fi
else
  log "No package.json; static build needs no dependencies."
fi

# Build. Prefer an explicit package build, otherwise copy the static source.
if [[ -f "$PROJECT_DIR/package.json" ]] && \
   node -e 'const p=require("./package.json");process.exit(p.scripts&&p.scripts.build?0:1)' 2>/dev/null; then
  timed npm run build
elif [[ -d "$PROJECT_DIR/site" ]]; then
  timed rm -rf "$DIST"
  timed mkdir -p "$DIST"
  timed cp -R "$PROJECT_DIR/site/." "$DIST/"
else
  echo "No package build script and no site/ directory to publish." >&2
  exit 1
fi

[[ -f "$DIST/index.html" ]] || { echo "Built output is missing $DIST/index.html" >&2; exit 1; }

# Declare the built static directory for the controller.
timed mkdir -p "$WEB_DIR"
timed python3 - "$WEB_DIR/deployment-output.json" "$PROJECT_DIR" "$DIST" <<'PY'
import json
import sys

path, project, directory = sys.argv[1:4]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"project": project, "directory": directory}, handle)
PY
log "Wrote $WEB_DIR/deployment-output.json"

log "Serving $DIST at http://0.0.0.0:$PORT"
# Keep the server in the foreground; the controller owns the tmux session.
exec python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$DIST"
