#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EXTENSION_DIR="$ROOT_DIR/bootdev-extension"
MANIFEST_FILE="$EXTENSION_DIR/manifest.json"
RELEASES_DIR="$ROOT_DIR/releases"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to package the extension." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to read the extension version from manifest.json." >&2
  exit 1
fi

VERSION="$(
  python3 - "$MANIFEST_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    manifest = json.load(f)

print(manifest["version"])
PY
)"

PACKAGE_NAME="catalyst-v${VERSION}"
OUT_FILE="$RELEASES_DIR/${PACKAGE_NAME}.zip"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$RELEASES_DIR"
mkdir -p "$TMP_DIR/$PACKAGE_NAME"

cp -R "$EXTENSION_DIR"/. "$TMP_DIR/$PACKAGE_NAME"/

cd "$TMP_DIR"

rm -f "$OUT_FILE"

zip -r "$OUT_FILE" "$PACKAGE_NAME" \
  -x "*/.git/*" \
  -x "*/node_modules/*" \
  -x "*/.DS_Store" \
  -x "*.log"

echo "Created $OUT_FILE"
