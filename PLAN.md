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
- [x] Span text uses `TextExcerpt`: small selections send full `head`; large selections send first/last lines (`head`/`tail`) with per-edge character caps.

## Decisions: VS Code IDE plugin

- [x] Plugin lives in this repo under `ide-plugins/vscode`; Marketplace extension ID intended as `xl0.pi-lovely-ide`.
- [x] Plugin has its own VS Code subpackage: `package.json`, `tsconfig.json`, `src/extension.ts`, esbuild-bundled VSIX packaging scripts, and root `dev-install-vscode-plugin.sh [ide-cli]` helper.
- [x] Protocol code lives in shared package/module, intended for Pi extension, VS Code plugin, and future notebook package.
- [x] One WebSocket server per VS Code extension host/window; lockfile lists current workspace folders and updates on workspace changes.
- [x] Lockfile name is `<port>.lock`.
- [x] `Pi: Mention Selection` command sends current selection/cell spans and has default `Alt+Shift+L` keybinding. If multiple eligible Pi targets, use QuickPick by session name/id/pid; if one, send directly.
- [x] Store Pi connection metadata from `hello`; broadcast changed non-empty `selection` to subscribed conns; send `mention` to chosen subscribed conn.

## Follow-ups deferred

- [ ] Notebook selection/mention UX: VS Code now sends cell-relative text ranges for active notebook cell text selections, whole-cell spans for notebook cell selections/mention, and keeps notebook selections stable across scroll-driven active-editor churn; Pi display/context still treats ranges as file line refs and does not render cell addresses. Finish after notebook execution model lands.

## Notebook follow-up decisions still open

- [ ] Notebook execution protocol namespace (`notebook/*`) and whether it belongs in v2 or separate doc.
- [ ] Notebook execution address model beyond selection/mention spans: path + stable cell id + index fallback is likely.
- [ ] Notebook execution result model: return final cell outputs/status first; streaming optional later.

## Design grill: VS Code selection event simplification

Question tree:

- [x] Semantics: IDE Selection is driven by explicit VS Code selection events, not active editor state. Active editor/tab/visible-range changes do nothing.
- [x] Empty/cursor selections: publish same-position range spans; active editor changes alone do nothing.
- [x] Event sources: keep only text-editor selection listener for ambient selection; notebook-editor selection events are ignored.
- [x] Event payload source: build payload directly from selection event object, not ambient active editor state.
- [x] Notebook behavior: do not use notebook cell-selection events for ambient selection for now. React only to `onDidChangeTextEditorSelection`; for notebook-cell text docs, find owning notebook cell by document/URI.
- [x] Active filtering: do not filter; publish selection events from the VS Code event object regardless of active editor for now.
- [x] Connection hello: do not send current/cached selection; wait for next selection event.
- [x] Dedupe/cache: keep only per-socket `lastSelectionKeys`; remove retained/cached last selection event.
- [x] Clear affordance: no explicit command/protocol affordance for now; cursor movement updates IDE Selection instead of clearing.
- [x] Verification: VS Code plugin typecheck passes.

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
  - [x] Add VS Code `Pi Lovely IDE` log output channel for server/lockfile/connection state plus all listened VS Code events and outgoing protocol summaries at debug without raw selected text.
  - [x] Observe text selection events and publish selected ranges/cursor positions to subscribed conns regardless of file workspace; send full small span text or first/last line excerpts for large spans.
  - [x] Support notebook spans: notebook cell text selections as `cell + range`; ambient notebook cell-selection events are ignored.
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
