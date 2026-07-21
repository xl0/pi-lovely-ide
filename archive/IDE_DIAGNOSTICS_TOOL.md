# Archived IDE diagnostics tool

Status: not part of active protocol or extension.

## Why archived

Explicit VS Code Problems attachments now cover the intended user workflow:

- `Pi: Attach Problems` snapshots selection/file diagnostics.
- `Pi: Attach Workspace Problems` snapshots workspace diagnostics.
- Pi inserts `[problems: path#line-range]` for selections or `[problems: path]` for files
  and injects the snapshot only when submitted, bounding aggregate model context with a
  temp-file link when needed.

The pull tool duplicated that path while adding model tool surface, reverse JSON-RPC request state, cancellation, timeouts, and more protocol API.

Reconsider only if Pi needs autonomous post-edit diagnostics without user action.

## Former behavior

Pi registered:

```text
ide_get_diagnostics(path?: string, glob?: string)
```

- `path`: exact path, preferably workspace-relative.
- `glob`: workspace-relative Node glob.
- Neither: all diagnostics known to the IDE.
- `path` and `glob` were mutually exclusive.
- Results rendered as `path:line:character [severity source code] message`.
- Output used Pi's 50KB/2000-line head truncation.

Pi sent this request to the IDE:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "get_diagnostics",
  "params": {
    "uri": "file:///workspace/src/app.ts"
  }
}
```

Omitting `uri` requested all cached documents. Result:

```json
{
  "documents": [
    {
      "uri": "file:///workspace/src/app.ts",
      "diagnostics": []
    }
  ]
}
```

The VS Code implementation answered with `vscode.languages.getDiagnostics(uri)` or `vscode.languages.getDiagnostics()`.

## Removed pieces

- Protocol constant `IDE_DIAGNOSTICS_METHOD = "get_diagnostics"`.
- `DiagnosticsGetParamsSchema` and `DiagnosticsGetResultSchema`.
- Parsed `get_diagnostics` request kind.
- VS Code `get_diagnostics` request handler.
- Pi `ide_get_diagnostics` tool registration, path canonicalization, glob filtering, rendering, and truncation.
- `IdeConnection.request()` correlation map, 10-second timeout, abort handling, and disconnect rejection.

The shared diagnostic document/range schemas remain active because diagnostics events use them.

## Revival outline

1. Restore typed `get_diagnostics` request/result schemas in shared protocol.
2. Restore correlated requests in `IdeConnection`.
3. Answer `get_diagnostics` from VS Code's cached diagnostics API.
4. Register `ide_get_diagnostics` with separate `path` and `glob` params.
5. Canonicalize exact paths and glob roots, especially for symlinked workspaces.
6. Keep unknown methods failing immediately with JSON-RPC `-32601`.
7. Keep model output bounded and avoid persisting unbounded result payloads.
