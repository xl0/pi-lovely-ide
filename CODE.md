# Codebase

Pi package providing one extension at `extensions/ide-integration/index.ts`.

Repository README now embeds `demo.gif` for GitHub rendering and links it to the hosted release asset `demo.mp4`.

The extension connects to Claude Code IDE WebSocket lock files from `~/.claude/ide` on `session_start`, only when an active lock has `transport: "ws"`, live PID, auth token, and a workspace folder exactly matching Pi's current `cwd`.

Runtime state: one WebSocket, connected IDE metadata, non-empty current selection, current Pi extension context, and two boolean flags (`autoConnectOnStartup`, `autoReconnect`). Performs MCP initialize + `notifications/initialized`, replies `{}` to IDE-initiated JSON-RPC requests, tracks non-empty `selection_changed`, and handles `at_mentioned` by pasting an `@file#x-y` reference plus trailing space into the active Pi editor message.

Footer status shows connection state, IDE name, PID, and current selection. When both auto flags are off, shows "IDE disabled" (muted); otherwise disconnected shows "IDE disconnected" (error).

`/ide` shows a `ctx.ui.custom(..., { overlay: true })` overlay listing discovered IDE endpoints, two boolean toggle items (auto-connect on startup, auto-reconnect on loss), and a Disconnect option. Arrow keys navigate, Space toggles boolean items live, Enter accepts the selected action, Esc cancels. Current connection is pre-selected. Toggle state is persisted to `<project>/.pi/xl0-lovely-ide.json` (flat JSON, one bool per flag) on any toggle change, and loaded on session_start.

No tools, prompt injection, custom footer, or automatic selection insertion.
