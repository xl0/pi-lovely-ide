# Plan

## Question tree: simpler IDE protocol

- [x] 1. Goal: clone Claude Code compatibility, or define pi-native protocol and bridge Claude only as an adapter?
  - Decision: pi-native minimal protocol; keep Claude compatibility as discovery/input adapter only.
- [x] 2. Transport/discovery: keep MCP JSON-RPC + lockfiles, or use smaller JSON-RPC-over-WS contract?
  - Decision: keep local lockfile + JSON-RPC-lite over WebSocket; drop SSE and MCP as native protocol requirements.
- [x] 3. Capability boundary: what is needed now vs future tools?
  - Decision: v1 is events only: `selection`, `mention`, plus connection-level `hello`/`ping`; no IDE tool calls, no `activeFile`/`openFiles`.
- [x] 4. Workspace/path model: exact workspace match only, ancestor match, multi-root, WSL?
  - Decision: support multi-root as `workspaces: string[]`; agent matches cwd equal/descendant of any root; document path namespace as server-side absolute path.
- [x] 5. Auth/staleness: token, PID, port probing, lock cleanup?
  - Decision: token required; PID advisory, ignore lockfile if present and dead; no stale port probing in v1.
- [x] 6. Message shape: named notifications vs one generic event envelope?
  - Decision: one `event` notification with typed `type`; selection and mention share range/text shape.
- [x] 7. Line/range semantics: zero-based wire vs one-based model/editor text?
  - Decision: zero-based wire with VS Code/LSP-style `start` inclusive, `end` exclusive; pi converts to one-based UI/model refs.
- [x] 8. Init lifecycle: MCP initialize/initialized vs explicit `hello`?
  - Decision: explicit `hello` request/response with full Pi instance identity: `client { name, version, pid, mode }`, `session { id, name? }`, `connection { id, subscriptions }`, and `workspace`; IDE groups connections by session and routes events by subscriptions.
- [x] 9. Extensibility: capabilities, schema versioning, unknown events?
  - Decision: integer `protocol: 1`; no capabilities in v1; unknown event types ignored.
- [x] 10. Docs outcome: add pi-native protocol doc and keep Claude Code protocol doc?
  - Decision: add `PI_IDE_PROTOCOL.md` as canonical pi-native v1; keep `CC_IDE_PROTOCOL.md` as Claude Code compatibility/reference doc.

## Question tree: notebook execution through IDE

- [x] 1. Connection topology: notebook extension opens its own IDE connection, or reuses lovely-ide connection?
  - Decision: separate packages may open separate IDE connections. `hello.connection.subscriptions` tells IDE which selection/mention events each connection wants; IDE groups connections by `session.id`.
- [ ] 2. Protocol scope: keep Pi IDE Protocol v1 events-only and add notebook requests in v2/separate namespace?
  - Recommended: keep v1 stable; notebook execution is request/response namespace (`notebook/*`) layered on same connection after separate decision.
- [x] 3. Target identity: how does IDE distinguish several Pi instances and feature users?
  - Decision: `hello` includes `session { id, name? }` and `connection { id, subscriptions }`; IDE groups by session, routes events by connection subscriptions.
- [ ] 4. Notebook address model: path+cell index, cell id, VS Code notebook URI, or content hash?
  - Recommended: path + stable cell id when available, index as fallback.
- [ ] 5. Execution result model: stream outputs, return final notebook, or rely on IDE saved file?
  - Recommended: start with request returning final cell outputs/status; streaming optional later.

## Candidate v1 shape

- Lockfile `~/.pi/ide/*.lock` preferred; optionally scan `~/.claude/ide/*.lock` for compatibility.
- Lock JSON: `{ "protocol": "pi-ide", "version": 1, "port": 1234, "pid": 1234, "workspaces": ["/abs/project"], "ide": "VS Code", "token": "..." }`.
- WS endpoint: `ws://127.0.0.1:<port>`; header `X-Pi-Ide-Authorization: <token>`.
- Client sends JSON-RPC `hello` with full Pi instance identity and `connection.subscriptions`; server replies accepted protocol + IDE metadata.
- Server sends JSON-RPC notifications:
  - `{ "method": "event", "params": { "type": "selection", "file": "/abs/file", "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 1, "character": 0 } }, "text": "..." } }`
  - `{ "method": "event", "params": { "type": "mention", "file": "/abs/file", "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 9, "character": 12 } }, "text": "..." } }`
