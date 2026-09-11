#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
	echo "usage: $0 /absolute/path/to/existing-vault [obsidian-vault-name-or-id-for-cli-activation]" >&2
	exit 2
fi

VAULT="$1"
CLI_VAULT="${2:-}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$ROOT/ide-plugins/obsidian"
TARGET_DIR="$VAULT/.obsidian/plugins/pi-lovely-ide"

if [[ "$VAULT" != /* ]]; then
	echo "vault path must be absolute" >&2
	exit 2
fi

if [[ ! -d "$VAULT" ]]; then
	echo "vault path does not exist: $VAULT" >&2
	exit 2
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
	echo "vault is missing .obsidian directory: $VAULT" >&2
	exit 2
fi

if ! command -v bun >/dev/null 2>&1; then
	echo "missing bun" >&2
	exit 127
fi

if [[ -n "$CLI_VAULT" ]] && ! command -v obsidian >/dev/null 2>&1; then
	echo "activation requested but missing Obsidian CLI: obsidian" >&2
	exit 127
fi

cd "$PLUGIN_DIR"
bun install
bun run typecheck
bun run build

mkdir -p "$TARGET_DIR"
cp main.js manifest.json "$TARGET_DIR/"
if [[ -f styles.css ]]; then
	cp styles.css "$TARGET_DIR/"
fi

cat <<EOF
Installed Pi Lovely IDE files to:
$TARGET_DIR
EOF

obsidian_command() {
	local output status
	if output="$(obsidian "vault=$CLI_VAULT" "$@" 2>&1)"; then
		status=0
	else
		status=$?
	fi
	if [[ $status -ne 0 ]]; then
		printf '%s\n' "$output" >&2
		exit "$status"
	fi
	if grep -qE '^[[:space:]]*Error:' <<<"$output"; then
		printf '%s\n' "$output" >&2
		echo "Obsidian CLI reported an error" >&2
		exit 1
	fi
	printf '%s\n' "$output"
}

if [[ -n "$CLI_VAULT" ]]; then
	ENABLED_PLUGINS="$(obsidian_command plugins:enabled filter=community format=tsv)"
	if grep -Fxq 'pi-lovely-ide' <<<"$ENABLED_PLUGINS"; then
		obsidian_command plugin:reload id=pi-lovely-ide
	else
		obsidian_command plugin:enable id=pi-lovely-ide filter=community
	fi
else
	cat <<EOF

Files installed only; Obsidian was not enabled or reloaded (no CLI vault argument).
First install: enable Pi Lovely IDE in Obsidian Settings -> Community plugins -> Installed plugins.
After update, either toggle Pi Lovely IDE off/on, restart Obsidian, or run:
obsidian vault="<vault-name-or-id>" plugin:reload id=pi-lovely-ide

Pass explicit vault name/id as second argument to automatically enable or reload the plugin.
CLI activation requires Obsidian 1.12.7+, CLI enabled in Settings -> General, and Community plugins allowed.
EOF
fi

echo
echo "In Pi, run /reload to load the updated IDE integration."
