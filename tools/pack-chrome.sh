#!/bin/bash
# Packs the Chrome extension for download: one folder, "Pareto for Chrome", holding the
# extension and READ ME FIRST.txt (from tools/chrome-readme.txt), zipped into
# dist/pareto-chrome-<version>.zip. The version comes from extension/manifest.json.
#
#   tools/pack-chrome.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FOLDER="$WORK/Pareto for Chrome"
mkdir -p "$FOLDER"
cp -R extension/. "$FOLDER/"
find "$FOLDER" -name ".DS_Store" -delete
sed "s/__VERSION__/$VERSION/" tools/chrome-readme.txt > "$FOLDER/READ ME FIRST.txt"
mkdir -p dist
ZIP="$PWD/dist/pareto-chrome-$VERSION.zip"
rm -f "$ZIP"
(cd "$WORK" && zip -qr -X "$ZIP" "Pareto for Chrome")
echo "Packed $ZIP ($(du -h "$ZIP" | cut -f1))"
