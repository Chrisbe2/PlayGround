#!/usr/bin/env bash
# Capture desktop and mobile screenshots of a running preview.
set -euo pipefail
cd "$(dirname "$0")"

: "${CAPTURE_URL:?Set CAPTURE_URL to the running preview URL.}"
: "${CAPTURE_DIR:?Set CAPTURE_DIR to a directory outside the project source.}"
export CAPTURE_URL CAPTURE_DIR

PROJECT_DIR="$(pwd -P)"
CAPTURE_DIR_ABS="$(realpath -m "$CAPTURE_DIR")"

case "$CAPTURE_DIR_ABS/" in
  "$PROJECT_DIR/"*)
    echo "CAPTURE_DIR must be outside the project source: $CAPTURE_DIR_ABS" >&2
    exit 1
    ;;
esac

timed() {
  printf '[timing] %s\n' "$*"
  /usr/bin/time -p "$@"
}

printf '[capture] URL: %s\n' "$CAPTURE_URL"
printf '[capture] Output: %s\n' "$CAPTURE_DIR_ABS"

timed mkdir -p "$CAPTURE_DIR_ABS"

# capture.mjs owns browser lifecycle, readiness checks, and exit classification.
timed node "$PROJECT_DIR/capture.mjs"

timed test -s "$CAPTURE_DIR_ABS/final-desktop.png"
timed test -s "$CAPTURE_DIR_ABS/final-mobile.png"
timed stat -c '%n %s bytes' \
  "$CAPTURE_DIR_ABS/final-desktop.png" \
  "$CAPTURE_DIR_ABS/final-mobile.png"

printf '[capture] Wrote final-desktop.png and final-mobile.png\n'
