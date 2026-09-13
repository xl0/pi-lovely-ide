# Pi Lovely IDE for Obsidian

Obsidian desktop plugin for Pi IDE Protocol v1.

- Starts authenticated localhost WebSocket server.
- Advertises vault root as Pi workspace in `~/.pi/ide/<port>.lock`.
- Removes its lock immediately on unload; startup clears closed-port records left by
  renderer reloads under the same PID, while preserving live endpoints.
- Publishes active Markdown note selection/cursor to connected Pi sessions while Obsidian window is focused.
- Commands:
  - `Pi: Mention Selection`
  - `Pi: Mention Whole Note`

Reading view sends selected rendered text with the note reference, without source line
numbers. Ambient context and `Pi: Mention Selection` preserve that bounded excerpt;
`Pi: Mention Whole Note` deliberately omits it. With no selection, only the note is sent.
Source/live-preview mode retains precise source ranges.

No diagnostics or notebooks are implemented.

## Build

```sh
bun install
bun run typecheck
bun run build
```

## Local install

From repo root:

```sh
./dev-install-obsidian-plugin.sh /absolute/path/to/vault
```

With only a path, enable `Pi Lovely IDE` manually in Obsidian: Settings → Community plugins → Installed plugins.

To install and activate automatically via Obsidian CLI:

```sh
./dev-install-obsidian-plugin.sh /absolute/path/to/vault "vault-name-or-id"
```

The installer queries enabled community plugins in that vault, then enables
`pi-lovely-ide` if disabled (including first install), or reloads it if already enabled:

```sh
obsidian vault="vault-name-or-id" plugin:enable id=pi-lovely-ide filter=community
# On subsequent installs while enabled:
obsidian vault="vault-name-or-id" plugin:reload id=pi-lovely-ide
```

`vault=` must precede the command. CLI activation requires Obsidian 1.12.7+,
Settings → General → Command line interface enabled, and Community plugins allowed.
CLI errors fail the install command; the installer never edits `community-plugins.json`
directly or disables Restricted mode.
