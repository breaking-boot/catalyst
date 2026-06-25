#!/usr/bin/env bash
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT_FILE="${1:-bootdev-extension.zip}"

cd "$ROOT_DIR"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to package the extension." >&2
  exit 1
fi

rm -f "$OUT_FILE"
zip -r "$OUT_FILE" bootdev-extension \
  -x "*/.git/*" \
  -x "*/node_modules/*" \
  -x "*/.DS_Store" \
  -x "*.log"

echo "Created $OUT_FILE"
