# TODO

## Plan

Maintain `@xl0/pi-lovely-ide` as a small Pi extension for Claude Code IDE integration.

## Tasks

- [x] Connect to matching Claude Code IDE WebSocket lock files on startup.
- [x] Filter IDE endpoints to the current Pi project directory.
- [x] Show footer status for connection and current selection.
- [x] Insert deliberate IDE `at_mentioned` references into the current editor message.
- [x] Add `/ide` overlay for manual connect/switch/disconnect and auto-connect toggles.
- [x] Persist auto-connect and auto-reconnect settings in `.pi/xl0-lovely-ide.json`.
- [x] Automatically reconnect when matching IDE endpoints appear or connections drop.
