# Pi Lovely IDE

VS Code bridge for Pi IDE Protocol. Starts a local authenticated WebSocket server, advertises it via `~/.pi/ide/<port>.lock`, and sends editor selection, mention, and explicit diagnostics events to connected Pi sessions.

Use with the Pi package `@xl0/pi-lovely-ide`.

Default keybindings:

- `Alt+Shift+L` runs `Pi: Mention Selection`.
- `Alt+Shift+D` runs `Pi: Attach Problems`.

Commands:

- `Pi: Attach Problems` captures diagnostics and selected code intersecting the current
  selection, including its selected line ranges, or all active-document diagnostics without
  a selection.
- `Pi: Attach Workspace Problems` captures all cached workspace diagnostics.
- Notebook Problems include the cell id/index and cell-relative lines.
- A selection with no Problems shows a notification and sends nothing.
- Workspace Problems exclude empty diagnostic documents; if none remain, the command shows a
  notification and sends nothing.
