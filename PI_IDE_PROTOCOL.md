# Pi IDE Protocol v1

Pi IDE Protocol is a small local protocol for IDE extensions/plugins to send editor context events to Pi agent clients.

It is not MCP. It is not the Claude IDE protocol. Claude compatibility can be implemented as an adapter, but this document is the canonical pi-native contract.

## Roles

- **IDE server**: local IDE extension/plugin server.
- **Pi client**: one Pi extension connection for a Pi process/session and workspace. A single Pi session may open more than one connection; each connection declares which IDE events it wants.

All messages are UTF-8 JSON text frames over WebSocket. Request/response envelopes use JSON-RPC 2.0. Line and character positions on the wire are zero-based.

## Discovery

IDE servers advertise local endpoints by writing JSON lockfiles under:

```text
~/.pi/ide/*.lock
```

Lockfile names are opaque. `port` is carried in JSON.

```json
{
  "protocol": "pi-ide",
  "version": 1,
  "port": 51234,
  "pid": 1234,
  "workspaces": ["/home/me/project"],
  "ide": "VS Code",
  "token": "opaque-secret"
}
```

Fields:

- `protocol: "pi-ide"`
- `version: 1`
- `port: number` — TCP port for the WebSocket server.
- `pid?: number` — IDE/server process PID. Advisory; clients should ignore lockfiles whose present PID is dead.
- `workspaces: string[]` — absolute IDE-side workspace roots. Multi-root IDE windows list all roots.
- `ide?: string` — human display name.
- `token: string` — required bearer secret for local WebSocket auth.

A Pi client matches a lockfile when its cwd is equal to or descendant of any `workspaces` root after path normalization.

## Transport

Endpoint:

```text
ws://127.0.0.1:<port>
```

The Pi client sends the token during WebSocket handshake:

```text
X-Pi-Ide-Authorization: <token>
```

One complete JSON message is sent per WebSocket text frame. Binary frames are not used.

## Hello

After WebSocket connect, Pi sends `hello`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "hello",
  "params": {
    "protocol": 1,
    "client": {
      "name": "pi-lovely-ide",
      "version": "0.2.0",
      "pid": 12345,
      "mode": "tui"
    },
    "session": {
      "id": "abc123",
      "name": "Refactor auth"
    },
    "connection": {
      "id": "4c6df0ec-5a7b-4b9f-9332-5f0e7c9335ce",
      "subscriptions": ["selection", "mention"]
    },
    "workspace": "/home/me/project"
  }
}
```

Fields:

- `protocol: 1`
- `client.name: string`
- `client.version?: string`
- `client.pid: number`
- `client.mode?: string` — Pi mode such as `tui`, `rpc`, `json`, or `print`.
- `session.id: string` — stable Pi session id.
- `session.name?: string` — human session label.
- `connection.id: string` — stable unique id for this WebSocket connection, scoped to this Pi process/session lifetime.
- `connection.subscriptions?: string[]` — IDE-originated event types this connection wants. Valid v1 values are `selection` and `mention`. Missing or empty means no events. Subscriptions are fixed for the lifetime of the WebSocket connection; changing them requires reconnecting.
- `workspace: string` — Pi cwd/workspace for this connection.

IDE response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocol": 1,
    "ide": {
      "name": "VS Code",
      "version": "1.99.0"
    }
  }
}
```

The IDE may reject incompatible protocol versions or workspaces with JSON-RPC error.

`hello` lets the IDE show connected Pi instances. The IDE should group connections with the same `session.id` as one Pi session, using `session.name`, `session.id`, `client.pid`, and `client.mode` for display.

Event routing is based on `connection.subscriptions`. If several matching Pi sessions/connections subscribe to `mention`, the IDE should ask which target receives the explicit mention.

## Events

IDE sends editor-originated events as JSON-RPC notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "selection"
  }
}
```

Unknown `params.type` values must be ignored. The IDE should only send an event to connections whose `connection.subscriptions` includes that event type.

### Shared file range shape

`selection` and `mention` use the same file/range/text shape.

```json
{
  "type": "selection",
  "file": "/home/me/project/src/app.ts",
  "range": {
    "start": { "line": 10, "character": 2 },
    "end": { "line": 12, "character": 0 }
  },
  "text": "optional selected text"
}
```

Fields:

- `file: string | null` — absolute IDE-side path, or `null` for no active file/selection.
- `range: { start, end } | null` — zero-based editor range, or `null` for no selection.
- `range.start` — inclusive start position.
- `range.end` — exclusive end position.
- `text?: string` — selected/referenced text when cheaply available.

For line-only display, if `range.end.character === 0`, the final selected line is `range.end.line - 1`.

### `selection`

Ambient active editor selection changed. IDEs may send this to all connected Pi client connections matching the workspace and subscribed to `selection`.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "selection",
    "file": "/home/me/project/src/app.ts",
    "range": {
      "start": { "line": 10, "character": 2 },
      "end": { "line": 12, "character": 0 }
    },
    "text": "const x = 1;\nconst y = 2;\n"
  }
}
```

Empty selection:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "selection",
    "file": null,
    "range": null
  }
}
```

### `mention`

Explicit user action from the IDE to insert/send a file/range reference to one Pi client connection subscribed to `mention`. If multiple Pi sessions/connections are eligible, the IDE should ask which target receives the mention.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "mention",
    "file": "/home/me/project/src/app.ts",
    "range": {
      "start": { "line": 10, "character": 2 },
      "end": { "line": 12, "character": 8 }
    },
    "text": "selected text"
  }
}
```

Pi may render mention text as a human 1-based line reference, e.g. `@src/app.ts#11-13`.

## Ping

Either side may send:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "ping"
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

## Compatibility notes

`CC_IDE_PROTOCOL.md` documents Claude Code-compatible MCP discovery/messages. A Pi implementation may support that as an adapter, but native Pi IDE Protocol v1 is the lockfile + JSON-RPC-lite WebSocket contract above.
