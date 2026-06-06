# Codebase

Pi package `@xl0/pi-lovely-ide` in repo `xl0/pi-lovely-ide`. It provides one extension in `extensions/lovely-ide/`: `index.ts` owns WebSocket discovery/connect/reconnect/event wiring/status, `config.ts` owns persisted config, `selection.ts` owns IDE Selection + Selection Snapshot lifecycle, and `command.ts` owns `/ide` UI. Targets Pi's Node runtime and imports `WebSocket` from `undici`. Uses `typebox` for runtime JSON validation.

README embeds `demo.gif` and links it to the hosted release asset `demo.mp4`.

The extension connects to Claude Code IDE WebSocket lock files from `~/.claude/ide` on `session_start`, only when an active lock has `transport: "ws"`, live PID, auth token, and a workspace folder exactly matching Pi's current `cwd`. Connection attempts use a 3s timeout and concurrent connects are skipped/blocked.

Runtime state: one WebSocket, connected IDE metadata, current Pi extension context, `ConfigState` booleans (`autoConnectOnStartup`, `autoReconnect`, `selectionContext`), and `SelectionState` current IDE Selection + transient per-turn Selection Snapshot state. TypeBox validates persisted config JSON, IDE lockfile JSON, JSON-RPC envelopes, and `selection_changed`/`at_mentioned` params. Performs MCP initialize + `notifications/initialized`, replies `{}` to IDE-initiated JSON-RPC requests, tracks non-empty `selection_changed`, and handles `at_mentioned` by pasting a 1-based `@file#x-y` reference plus trailing space into the active Pi editor message.

Selection Context is on by default. For an idle interactive/RPC prompt with a non-empty IDE Selection, `input` snapshots file path + 1-based line range; `end.character === 0` maps final selected line to previous line. Selected text is included only for 1-2 lines and <=2KB UTF-8. `context` injects a transient user message after that prompt for each provider call in the turn, never session history: `<ide file="..." lines="..."></ide>` or with raw `<selected>` child.

Footer status uses key `lovely-ide`; shows connection state, IDE name, PID, and current selection. When both auto flags are off, shows "IDE disabled" (muted); otherwise disconnected shows "IDE disconnected" (error). Current selection is hidden when Selection Context is disabled.

`/ide` shows a `ctx.ui.custom(...)` selector listing discovered IDE endpoints, three boolean toggle items (auto-connect on startup, auto-reconnect on loss, selection context), and a Disconnect option. Arrow keys navigate, Space toggles boolean items live, Enter accepts the selected action, Esc cancels. Current connection is pre-selected. Toggle state is persisted to `<project>/.pi/xl0-lovely-ide.json` (flat JSON, one bool per flag) on any toggle change, and loaded on `session_start`.

No tools, system-prompt mutation, custom footer, or IDE tool calls.
