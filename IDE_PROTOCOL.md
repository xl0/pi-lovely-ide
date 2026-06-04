# IDE Integration Protocol

This document specifies a Claude-compatible IDE integration protocol for coding-agent clients and IDE extension/plugin servers. It is intended to be sufficient to implement either side without relying on any particular client or extension source code.

At the wire level, the IDE extension is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server and the coding agent is an MCP client. Discovery is done with local lockfiles; communication is standard MCP JSON-RPC over either Server-Sent Events (SSE) or WebSocket.

## Roles

- **IDE server**: an IDE extension/plugin that starts a local MCP server and advertises it with a lockfile.
- **Agent client**: a coding agent that scans lockfiles, chooses an IDE server for the current workspace, connects as an MCP client, calls IDE tools, and receives IDE notifications.

All JSON examples use JSON-RPC 2.0. Unless otherwise stated, line and character positions are zero-based.

## Connection Lifecycle

1. The IDE server starts a local MCP server bound to a local interface.
2. The IDE server writes a lockfile named `<port>.lock` in the IDE lockfile directory.
3. The agent client scans lockfiles and selects one whose advertised workspace matches the agent session workspace/current directory.
4. The agent connects to the advertised port using the selected transport.
5. Client and server complete the normal MCP initialization handshake.
6. The client sends an `ide_connected` JSON-RPC notification.
7. The client calls IDE tools with MCP `tools/call` requests. The server may send IDE notifications back to the client.

## Discovery Lockfiles

The IDE server advertises itself by creating a lockfile under:

```text
~/.claude/ide/*.lock
```

On WSL, an agent running inside Linux should also look for Windows-side IDE lockfiles in Windows user-profile equivalents, for example:

```text
/mnt/c/Users/<user>/.claude/ide/*.lock
```

The filename supplies the TCP port:

```text
~/.claude/ide/51234.lock  ->  port 51234
```

Clients should ignore files whose basename is not a valid TCP port followed by `.lock`.

### JSON Lockfile Format

New servers should write JSON:

```json
{
  "workspaceFolders": ["/absolute/workspace/path"],
  "pid": 1234,
  "ideName": "Example IDE",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "opaque-token"
}
```

Fields:

- `workspaceFolders?: string[]` — absolute workspace/project roots open in the IDE. Paths are in the IDE server's filesystem namespace.
- `pid?: number` — IDE process PID, used by clients for stale-lockfile detection or disambiguation.
- `ideName?: string` — human-readable IDE name for UI display.
- `transport?: "ws" | "sse"` — `"ws"` selects WebSocket. Absent, `"sse"`, or any non-`"ws"` value selects SSE for compatibility.
- `runningInWindows?: boolean` — `true` when the IDE server is running on Windows and the agent may be running inside WSL.
- `authToken?: string` — opaque shared secret for WebSocket authentication.

Servers should keep the lockfile current and remove it on shutdown when possible.

### Legacy Lockfile Format

If a lockfile is not valid JSON, clients should interpret its contents as newline-separated workspace folder paths:

```text
/absolute/workspace/path/one
/absolute/workspace/path/two
```

Empty lines should be ignored.

## Lockfile Selection and Validity

A lockfile is eligible when one of its `workspaceFolders` is equal to, or an ancestor of, the agent session workspace/current directory after path normalization.

Recommended client behavior:

1. Read candidate lockfiles, newest first.
2. Parse the port from the filename and metadata from the file contents.
3. Ignore stale entries where the PID is known to be gone and the advertised port is not accepting connections.
4. Keep entries whose workspace matches the current session.
5. If multiple entries match, choose the newest matching entry, ask the user, or apply an implementation-specific disambiguation rule.

The `pid` field is advisory. A client may use it to prefer the IDE process that launched the agent from an integrated terminal, but PID ancestry checks are not required for protocol compatibility.

## Host and Path Rules

### Host

The default connection host is:

```text
127.0.0.1
```

When the agent is running inside WSL and the lockfile has `runningInWindows: true`, the server is Windows-side. In that case the client should connect to the Windows host from WSL, commonly the default gateway IP from `ip route`, and may fall back to `127.0.0.1` if gateway detection fails.

### Paths

- Paths in lockfiles are in the IDE server's filesystem namespace.
- Paths sent to IDE tools should also be in the IDE server's filesystem namespace.
- A WSL agent talking to a Windows IDE should convert local WSL paths to Windows/IDE paths before sending them to tools.
- For workspace matching, a WSL agent should compare both the advertised IDE path and a local converted path when possible.
- WSL UNC paths of the form `\\wsl$\\<distro>\\...` or `\\wsl.localhost\\<distro>\\...` should only match the same WSL distro.
- Normalize Unicode paths consistently, preferably NFC.
- On Windows, compare drive letters case-insensitively. Implementations may compare the whole path case-insensitively on case-insensitive filesystems.

## Transports

### SSE Transport

SSE is selected when `transport` is absent or not `"ws"`.

Endpoint:

```text
http://<host>:<port>/sse
```

The connection uses standard MCP over SSE. The lockfile `authToken` is not part of the SSE transport contract.

### WebSocket Transport

WebSocket is selected when:

```json
{ "transport": "ws" }
```

Endpoint:

```text
ws://<host>:<port>
```

Requirements:

- WebSocket subprotocol: `mcp`
- Message format: one complete MCP JSON-RPC message per WebSocket text frame
- Binary frames are not used by this protocol.
- If `authToken` is present, the client sends this HTTP header during the WebSocket handshake:

```text
X-Claude-Code-Ide-Authorization: <authToken>
```

The header name is a literal compatibility string. A server that writes an `authToken` should reject WebSocket connections with a missing or invalid token.

## MCP Handshake

After transport connection, client and server perform normal MCP initialization:

1. Client sends `initialize`.
2. Server responds with its MCP protocol version, capabilities, and server info.
3. Client sends the `notifications/initialized` notification.
4. Client may call `tools/list` and then `tools/call`.

Example initialization request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "example-agent", "version": "1.0.0" }
  }
}
```

The exact MCP protocol version is negotiated according to MCP. The IDE server must support MCP tools.

After MCP initialization succeeds, the client sends:

```json
{
  "jsonrpc": "2.0",
  "method": "ide_connected",
  "params": { "pid": 12345 }
}
```

`pid` is the agent client process PID. Servers may use it for logging, lifecycle tracking, or diagnostics.

## Tool Calls

IDE features are invoked with standard MCP `tools/call` requests.

Example WebSocket text frame:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "openDiff",
    "arguments": {
      "old_file_path": "/absolute/path/to/file",
      "new_file_path": "/absolute/path/to/file",
      "new_file_contents": "complete proposed file contents",
      "tab_name": "Agent diff: file.ts"
    }
  }
}
```

A successful MCP tool response uses the standard MCP tool-result shape:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{ "type": "text", "text": "..." }]
  }
}
```

Servers should return JSON-RPC errors or MCP tool errors for invalid arguments, unsupported operations, or internal failures.

## IDE Tool: `openDiff`

Opens an editable diff tab in the IDE and keeps the tool call pending until the user saves, closes, or rejects the diff.

Arguments:

```json
{
  "old_file_path": "/absolute/path/to/file",
  "new_file_path": "/absolute/path/to/file",
  "new_file_contents": "complete proposed file contents",
  "tab_name": "Agent diff: file.ts"
}
```

Fields:

- `old_file_path: string` — IDE-side path for the baseline/left side. The server typically reads the current file contents from this path.
- `new_file_path: string` — IDE-side target path for the proposed/right side. Usually the same path as `old_file_path`.
- `new_file_contents: string` — complete proposed contents for the right side.
- `tab_name: string` — opaque tab identifier/display name chosen by the client. Servers should preserve it exactly for later `close_tab` calls.

Expected result content is one of the following.

### File Saved

```json
[
  { "type": "text", "text": "FILE_SAVED" },
  { "type": "text", "text": "complete saved contents" }
]
```

Meaning: the user saved the proposed side. The second text block contains the final saved file contents.

### Tab Closed

```json
[{ "type": "text", "text": "TAB_CLOSED" }]
```

Meaning: the diff tab was closed without explicit rejection. Clients conventionally treat this as acceptance of `new_file_contents`.

### Diff Rejected

```json
[{ "type": "text", "text": "DIFF_REJECTED" }]
```

Meaning: the user rejected the diff. Clients conventionally keep the original file contents.

## IDE Tool: `close_tab`

Closes one named IDE tab.

Arguments:

```json
{ "tab_name": "Agent diff: file.ts" }
```

Fields:

- `tab_name: string` — exact tab identifier/display name previously supplied by the client.

Result content is ignored.

## IDE Tool: `closeAllDiffTabs`

Closes all diff tabs created for this protocol.

Arguments:

```json
{}
```

Result content is ignored.

## IDE Tool: `openFile`

Ensures a file is loaded by the IDE, typically so language services can produce diagnostics.

Arguments:

```json
{
  "filePath": "file:///absolute/path/or/plain/path",
  "preview": false,
  "startText": "",
  "endText": "",
  "selectToEndOfLine": false,
  "makeFrontmost": false
}
```

Fields:

- `filePath: string` — file URI or plain IDE-side path.
- `preview?: boolean` — whether the IDE may open the file in preview mode.
- `startText?: string` — optional text marker for selecting/revealing a range.
- `endText?: string` — optional end text marker for selecting/revealing a range.
- `selectToEndOfLine?: boolean` — if selecting from a marker, extend selection to the end of the line.
- `makeFrontmost?: boolean` — whether the IDE should bring the editor/window to the front.

Clients that only need diagnostics generally send empty `startText`/`endText`, `preview: false`, `selectToEndOfLine: false`, and `makeFrontmost: false`. Result content is ignored.

## IDE Tool: `getDiagnostics`

Fetches diagnostics for one URI or for all known files.

Single-file arguments:

```json
{ "uri": "file:///absolute/path/to/file" }
```

All-file arguments:

```json
{}
```

Expected result content contains a text block whose `text` is a JSON string with this shape:

```json
[
  {
    "uri": "file:///absolute/path/to/file",
    "diagnostics": [
      {
        "message": "diagnostic message",
        "severity": "Error",
        "range": {
          "start": { "line": 0, "character": 0 },
          "end": { "line": 0, "character": 10 }
        },
        "source": "typescript",
        "code": "1234"
      }
    ]
  }
]
```

Diagnostic file fields:

- `uri: string`
- `diagnostics: Diagnostic[]`

Diagnostic fields:

- `message: string`
- `severity: "Error" | "Warning" | "Info" | "Hint"`
- `range.start.line: number`
- `range.start.character: number`
- `range.end.line: number`
- `range.end.character: number`
- `source?: string`
- `code?: string`

Recognized URI prefixes include:

- `file://...` — real filesystem file.
- `_claude_fs_right:...` — proposed/right side of a diff virtual document.
- `_claude_fs_left:...` — baseline/left side of a diff virtual document.

The `_claude_fs_*` prefixes are literal compatibility prefixes. The text after the prefix is interpreted as a path in the IDE/server namespace.

## Optional Tool: `executeCode`

Some IDE servers expose an `executeCode` MCP tool for model-visible code execution. This protocol reserves the tool name but does not standardize its arguments or result shape. Servers that expose it must describe its schema through MCP `tools/list`; clients should rely on that schema rather than hard-coded assumptions.

Some agent clients may expose only selected IDE tools, commonly `executeCode` and `getDiagnostics`, to the model while keeping other IDE tools for internal client use. That exposure policy is not part of the wire protocol.

## IDE Notifications

The IDE server can send MCP JSON-RPC notifications to the agent client after initialization. Notifications have no `id`.

On WebSocket, each notification is one text frame:

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {}
}
```

## Notification: `selection_changed`

Sent when the active selection or active file context changes.

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "selection": {
      "start": { "line": 0, "character": 0 },
      "end": { "line": 2, "character": 5 }
    },
    "text": "selected text",
    "filePath": "/absolute/path/to/file"
  }
}
```

Fields:

- `selection?: { start, end } | null`
- `selection.start.line: number`
- `selection.start.character: number`
- `selection.end.line: number`
- `selection.end.character: number`
- `text?: string`
- `filePath?: string`

Selection positions are zero-based. If `selection` is `null` or omitted, there is no active selection. If `selection.end.character` is `0`, clients may treat the final line as not selected; this avoids counting the first character of the next line as part of the selection.

## Notification: `at_mentioned`

Sent when the user references a file or range from the IDE.

```json
{
  "jsonrpc": "2.0",
  "method": "at_mentioned",
  "params": {
    "filePath": "/absolute/path/to/file",
    "lineStart": 0,
    "lineEnd": 9
  }
}
```

Fields:

- `filePath: string`
- `lineStart?: number`
- `lineEnd?: number`

`lineStart` and `lineEnd` are zero-based on the wire. When both are present, `lineEnd` is the inclusive ending line of the referenced range.

## Minimal WebSocket Server Checklist

A compatible WebSocket-based IDE server should:

1. Start a local MCP server.
2. Accept WebSocket connections on `ws://<host>:<port>` using subprotocol `mcp`.
3. If using auth, validate `X-Claude-Code-Ide-Authorization` against the lockfile token.
4. Exchange one MCP JSON-RPC message per WebSocket text frame.
5. Implement MCP initialization, `tools/list`, and `tools/call`.
6. Implement the IDE tools needed by the desired feature set.
7. Write `~/.claude/ide/<port>.lock` with JSON metadata.
8. Keep the lockfile current and remove it on shutdown when possible.

Example lockfile:

```json
{
  "workspaceFolders": ["/home/alice/project"],
  "pid": 4242,
  "ideName": "Example IDE",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "random-opaque-token"
}
```
