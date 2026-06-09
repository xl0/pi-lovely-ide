# Changelog

## 0.1.0

- Initial VS Code/Cursor bridge for Pi IDE Protocol.
- Advertises local authenticated IDE WebSocket endpoint via `~/.pi/ide` lockfile.
- Sends active editor selections to connected Pi sessions.
- Adds `Pi: Mention Selection` command with default `Alt+Shift+L` keybinding.
- Supports whole-cell notebook selection spans where VS Code exposes them.
