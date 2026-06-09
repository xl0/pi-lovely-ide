# Pi Lovely IDE

VS Code bridge for Pi IDE Protocol. Starts a local authenticated WebSocket server, advertises it via `~/.pi/ide/<port>.lock`, and sends editor selection/mention events to connected Pi sessions.

Use with the Pi package `@xl0/pi-lovely-ide`.

Default keybinding: `Alt+Shift+L` runs `Pi: Mention Selection`.
