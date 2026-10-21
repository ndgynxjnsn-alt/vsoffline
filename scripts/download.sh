#!/usr/bin/env bash
# Internet connected machine: mirror VS Code binaries and the extensions in artifacts.txt,
# then pack them into an uncompressed tar for upload on the offline marketplace (Upload page).
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p artifacts bundles
# PUBLIC_URL only matters for the gallery service
PUBLIC_URL="${PUBLIC_URL:-unused}" docker compose --profile online run --rm --build sync

bundle="bundles/vscode-offline-$(date +%Y%m%d-%H%M%S).tar"
tar -cf "$bundle" -C artifacts --exclude=./specified.json --exclude=./updated.json .
echo "Created $bundle ($(du -h "$bundle" | cut -f1))"
