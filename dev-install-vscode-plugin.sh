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
bun run package

VSIX_NAME="$(node -e 'const p = require("./package.json"); process.stdout.write(`${p.name}-${p.version}.vsix`)')"
VSIX="$PLUGIN_DIR/$VSIX_NAME"

if [[ ! -f "$VSIX" ]]; then
	echo "VSIX not found: $VSIX" >&2
	exit 1
fi

"$IDE" --install-extension "$VSIX" --force
