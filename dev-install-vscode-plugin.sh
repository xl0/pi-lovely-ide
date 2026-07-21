#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
	echo "usage: $0 [ide-cli]" >&2
	exit 2
fi

IDE="${1:-code}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$ROOT/ide-plugins/vscode"

if ! command -v bun >/dev/null 2>&1; then
	echo "missing bun" >&2
	exit 127
fi

if ! command -v "$IDE" >/dev/null 2>&1; then
	echo "missing IDE CLI: $IDE" >&2
	exit 127
fi

cd "$PLUGIN_DIR"
bun install
rm -f -- "$PLUGIN_DIR"/*.vsix
bun run package

shopt -s nullglob
VSIX_FILES=("$PLUGIN_DIR"/*.vsix)
shopt -u nullglob

if [[ ${#VSIX_FILES[@]} -ne 1 ]]; then
	echo "expected exactly one VSIX in $PLUGIN_DIR" >&2
	exit 1
fi

VSIX="${VSIX_FILES[0]}"

"$IDE" --install-extension "$VSIX" --force
