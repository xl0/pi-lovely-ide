# Plan

## Decisions: Pi IDE Protocol v1

- [x] Use pi-native JSON-RPC-lite over local WebSocket; drop MCP/SSE/Claude Code compatibility from implementation.
- [x] Keep `CC_IDE_PROTOCOL.md` as historical Claude Code reference; `PI_IDE_PROTOCOL.md` is canonical.
- [x] IDE discovery via `~/.pi/ide/<port>.lock`, JSON carries `protocol: "pi-ide"`, `version: 1`, `port`, `pid`, `workspaces`, `ide`, `token`.
- [x] Token required; random per IDE server start; client sends `X-Pi-Ide-Authorization`.
- [x] PID advisory. Clean stale lockfiles only for `protocol: "pi-ide"`, present dead PID, and known same OS/PID namespace. No port probing or TTL in v1.
- [x] Multi-root workspaces supported; agent cwd matches equal/descendant of any root.
- [x] Client sends `hello` with `version`, `client { name, version, pid, mode }`, `session { id, name? }`, `connection { id, subscriptions }`, and `workspace`.
- [x] Static connection subscriptions; v1 events are `selection` and `mention`; unknown subscriptions/events ignored.
- [x] IDE groups multiple connections by `session.id`; routes events by `connection.subscriptions`.
- [x] Events use one JSON-RPC notification method `event` plus `params.type`.
- [x] Wire ranges are zero-based, VS Code/LSP-style `start` inclusive and `end` exclusive; Pi displays/model refs as 1-based lines.
- [x] `selection` and `mention` share `file + spans`. Each span may be a file range, notebook-cell range, or whole notebook cell (`cell` without `range`).

## Decisions: VS Code IDE plugin

- [x] Plugin lives in this repo under `ide-plugins/vscode`.
- [x] Plugin has its own VS Code subpackage: `package.json`, `tsconfig.json`, `src/extension.ts`, VSIX packaging scripts.
- [x] Protocol code lives in shared package/module, intended for Pi extension, VS Code plugin, and future notebook package.
- [x] One WebSocket server per VS Code extension host/window; lockfile lists current workspace folders and updates on workspace changes.
- [x] Lockfile name is `<port>.lock`.
- [x] `Pi: Mention Selection` command sends current selection/cell spans. If multiple eligible Pi targets, use QuickPick by session name/id/pid; if one, send directly.
- [x] Store Pi connection metadata from `hello`; broadcast changed non-empty `selection` to subscribed conns; send `mention` to chosen subscribed conn.

## Follow-ups deferred

- [ ] Notebook selection/mention UX: current protocol shape permits cell spans, but Pi display/context still only uses ranged file spans. Finish after notebook execution model lands.

## Notebook follow-up decisions still open

- [ ] Notebook execution protocol namespace (`notebook/*`) and whether it belongs in v2 or separate doc.
- [ ] Notebook execution address model beyond selection/mention spans: path + stable cell id + index fallback is likely.
- [ ] Notebook execution result model: return final cell outputs/status first; streaming optional later.

## Implementation plan

- [x] Create shared protocol package/module.
  - [x] `packages/protocol` or repo-local equivalent named for eventual `@xl0/pi-ide-protocol`.
  - [x] Export wire constants: protocol name/version and auth header.
  - [x] Export TypeBox schemas + TS types for lockfile, JSON-RPC envelope, `hello`, `event`, spans, and parsed IDE messages.
- [x] Add VS Code plugin under `ide-plugins/vscode`.
  - [x] Subpackage setup with VS Code engine, ESM TypeScript compile, activation events, command contribution.
  - [x] Start local WS server on activation, choose free port, generate token, write `~/.pi/ide/<port>.lock`.
  - [x] Update lockfile on workspace folder changes; remove own lockfile on deactivate.
  - [x] Opportunistically remove safe stale `pi-ide` lockfiles before writing.
  - [x] Validate WS auth header before registering connection.
  - [x] Implement `hello`, store connection metadata, group by session, support `ping`.
  - [x] Observe active editor/text selection changes and publish changed non-empty `selection` spans to subscribed conns regardless of file workspace; send empty events per connection to clear stale selection when needed; truncate span text payloads.
  - [x] Support notebook spans: whole selected cells where VS Code exposes them.
  - [x] Implement `Pi: Mention Selection` command and target QuickPick.
- [x] Update Pi extension to native Pi IDE Protocol.
  - [x] Discover `~/.pi/ide/*.lock`; remove Claude Code discovery/MCP initialize path.
  - [x] Send `hello` with Pi session id/name, mode, PID, connection id, subscriptions `selection`/`mention`.
  - [x] Parse `event` notifications with `spans`; adapt current single-selection snapshot/at-mention behavior to first ranged span.
  - [x] Keep `/ide` toggles/status/reconnect/debug notifications; add optional visible selection-context messages for manual inspection.
- [ ] Verify.
  - [x] `bun run typecheck` / `bun run check` for root.
  - [x] VS Code plugin compile.
  - [x] VS Code plugin package.
  - [ ] Manual: connect, footer status, ambient selection context, mention command, multi-selection, multiple Pi sessions target picker, stale lock cleanup.
