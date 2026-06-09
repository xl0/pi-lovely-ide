# Pi IDE Protocol v1

Pi IDE Protocol is a small local protocol for IDE extensions/plugins to send editor context events to Pi agent clients.

It is not MCP. It is not the Claude Code IDE protocol. This document is the canonical pi-native contract.

## Roles

- **IDE server**: local IDE extension/plugin server.
- **Pi client**: one Pi extension connection for a Pi process/session and workspace. A single Pi session may open more than one connection; each connection declares which IDE events it wants.

All messages are UTF-8 JSON text frames over WebSocket. Request/response envelopes use JSON-RPC 2.0. Line and character positions on the wire are zero-based.

## Discovery

IDE servers advertise local endpoints by writing JSON lockfiles under:

```text
~/.pi/ide/*.lock
```

Lockfile names should be `<port>.lock`. `port` is also carried in JSON so clients do not need to parse filenames as protocol data.

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

Servers should remove their lockfile on shutdown/deactivate when possible. Servers should also opportunistically remove stale `pi-ide` lockfiles before writing their own. A lockfile is safe to delete only when all are true:

- It parses as `protocol: "pi-ide"`.
- It has a `pid`.
- That PID is known to be in the same OS/PID namespace as the process doing cleanup.
- That PID is dead.

If PID namespace is unclear, or `pid` is absent, leave the lockfile. Clients should ignore dead-PID lockfiles using the same-namespace rule. Port probing and mtime TTL cleanup are not part of v1.

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

JSON-RPC `id` values may be strings or numbers. Clients should use monotonically increasing numbers unless they need string ids. Notifications omit `id`.

## Hello

After WebSocket connect, Pi sends `hello`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "hello",
  "params": {
    "version": 1,
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

- `version: 1`
- `client.name: string`
- `client.version?: string`
- `client.pid: number`
- `client.mode?: string` — Pi mode such as `tui`, `rpc`, `json`, or `print`.
- `session.id: string` — stable Pi session id.
- `session.name?: string` — human session label.
- `connection.id: string` — stable unique id for this WebSocket connection, scoped to this Pi process/session lifetime.
- `connection.subscriptions?: string[]` — IDE-originated event types this connection wants. Valid v1 values are `selection` and `mention`. Missing or empty means no events. Unknown strings are ignored. Subscriptions are fixed for the lifetime of the WebSocket connection; changing them requires reconnecting.
- `workspace: string` — Pi cwd/workspace for this connection.

IDE response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "version": 1,
    "ide": {
      "name": "VS Code",
      "version": "1.99.0"
    }
  }
}
```

The IDE may reject incompatible `version` values or workspaces with JSON-RPC error.

`hello` lets the IDE show connected Pi instances. The IDE should group connections with the same `session.id` as one Pi session, using `session.name`, `session.id`, `client.pid`, and `client.mode` for display.

Event routing is based on `connection.subscriptions`. If several matching Pi sessions/connections subscribe to `mention`, the IDE should ask which target receives the explicit mention.

## Events

IDE sends editor-originated events as JSON-RPC notifications. Shape sketch only; concrete events below include required `file` and `spans` fields.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "selection",
    "...": "event fields"
  }
}
```

Unknown `params.type` values must be ignored. The IDE should only send an event to connections whose `connection.subscriptions` includes that event type.

### Shared location shape

`selection` and `mention` use the same file/spans shape. A span is either a text range in a file, a text range in a notebook cell, or a whole notebook cell.

```json
{
  "type": "selection",
  "file": "/home/me/project/src/app.ts",
  "spans": [
    {
      "range": {
        "start": { "line": 10, "character": 2 },
        "end": { "line": 12, "character": 0 }
      },
      "text": "optional selected text"
    }
  ]
}
```

Notebook example:

```json
{
  "type": "selection",
  "file": "/home/me/project/notebook.ipynb",
  "spans": [
    {
      "cell": {
        "index": 3,
        "id": "abc123"
      },
      "range": {
        "start": { "line": 1, "character": 0 },
        "end": { "line": 2, "character": 5 }
      },
      "text": "optional selected text"
    },
    {
      "cell": {
        "index": 4,
        "id": "def456"
      },
      "text": "optional full cell text"
    }
  ]
}
```

Fields:

- `file: string | null` — absolute IDE-side path, or `null` for no active file/selection.
- `spans: Span[]` — selected/referenced spans in `file`. Empty means no selection/reference.
- `span.cell?: { index?: number; id?: string }` — notebook cell address when `file` is a notebook and the span is inside one cell. `index` is zero-based. `id` is the notebook cell id when available.
- `span.range?: { start, end }` — zero-based editor range. When `span.cell` is present, range positions are relative to the cell text, not the serialized notebook file. Missing `range` with `cell` means the whole cell.
- `span.range.start` — inclusive start position.
- `span.range.end` — exclusive end position.
- `span.text?: string` — selected/referenced text when cheaply available. Senders may truncate large text and should mark truncation in the string.

For line-only display, if `span.range.end.character === 0`, the final selected line is `span.range.end.line - 1`.

A span without `range` is only valid when `cell` is present. A v1 event represents spans from one file only.

### `selection`

Ambient active editor selection changed. IDEs may send this to all connected Pi client connections subscribed to `selection`; selected files may be outside the Pi workspace.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "selection",
    "file": "/home/me/project/src/app.ts",
    "spans": [
      {
        "range": {
          "start": { "line": 10, "character": 2 },
          "end": { "line": 12, "character": 0 }
        },
        "text": "const x = 1;\nconst y = 2;\n"
      }
    ]
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
    "spans": []
  }
}
```

### `mention`

Explicit user action from the IDE to insert/send a file/range reference to one Pi client connection subscribed to `mention`; mentioned files may be outside the Pi workspace. If multiple Pi sessions/connections are eligible, the IDE should ask which target receives the mention.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "mention",
    "file": "/home/me/project/src/app.ts",
    "spans": [
      {
        "range": {
          "start": { "line": 10, "character": 2 },
          "end": { "line": 12, "character": 8 }
        },
        "text": "selected text"
      }
    ]
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

`CC_IDE_PROTOCOL.md` documents the old Claude Code-compatible MCP discovery/messages as historical reference. Native Pi IDE Protocol v1 is the lockfile + JSON-RPC-lite WebSocket contract above.
