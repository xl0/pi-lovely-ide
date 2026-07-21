# Changelog

## 0.1.2

- Adds explicit active-file and workspace Problems attachments.
- Adds selected-code context and notebook cell locations to Problems attachments.
- Improves multi-session targeting, selection handling, reconnects, and debug logging.

## 0.1.0

- Initial VS Code/Cursor bridge for Pi IDE Protocol.
- Advertises local authenticated IDE WebSocket endpoint via `~/.pi/ide` lockfile.
- Sends active editor selections to connected Pi sessions.
- Adds `Pi: Mention Selection` command with default `Alt+Shift+L` keybinding.
- Supports notebook cell text selections as cell-relative ranged spans.
