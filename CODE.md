# Codebase

## Overview

`@xl0/pi-lovely-ide` is a Pi package that bridges Pi with IDEs over the Pi IDE Protocol.

- Published npm package includes:
  - Pi extension in `extensions/lovely-ide/`.
  - Shared protocol module in `packages/protocol/src/`.
- Repo also includes separately distributed VS Code extension in `ide-plugins/vscode/`.
- Canonical protocol doc: `docs/PI_IDE_PROTOCOL.md`.
- `docs/CC_IDE_PROTOCOL.md` is historical Claude Code reference only.
- `archive/IDE_DIAGNOSTICS_TOOL.md` records the removed model-pulled diagnostics design.
- Root TS config is strict, including `exactOptionalPropertyTypes`.
- Root scripts type-check/check both Pi package and VS Code subpackage.
- Runtime validation uses Valibot in shared protocol and extension-local state.
- Pi peer/dev dependency is `@earendil-works/pi-coding-agent` `^0.80.10` for
  typed `session_info_changed` support.
- Scoped settings use `@xl0/pi-lovely-config`.

## Shared protocol module

`packages/protocol/src/index.ts` exports Pi IDE Protocol v1 constants, schemas, types, and parsers.

- Constants:
  - `PI_IDE_PROTOCOL = "pi-ide"`.
  - `PI_IDE_PROTOCOL_VERSION = 1`.
  - `PI_IDE_AUTH_HEADER = "X-Pi-Ide-Authorization"`.
- Wire methods/events:
  - Methods: `hello`, `event`, `ping`, `session_info_changed`.
  - Events: `selection`, `mention`, `diagnostics`.
- Schemas/types cover:
  - JSON-RPC-ish envelopes.
  - IDE lockfiles.
  - hello params/result.
  - event params.
  - diagnostic event documents.
  - file/cell spans, inclusive ranges, selected line ranges, and `TextExcerpt`.
- Parsers:
  - `parseJsonRpcMessage(raw)`.
  - `parseIdeJsonRpcMessage(message)`.
  - `parseIdeMessage(raw)`.
  - `parseIdeLockFile(raw)`.
- Internal `parseIdeEventParams` validates selection/mention spans and diagnostics scope/file/selected-line consistency.
- Only externally consumed names are exported; internal schemas/aliases stay module-private.

## Pi extension layout

`extensions/lovely-ide/` contains one Pi extension.

- `index.ts` owns lifecycle, IDE discovery/reconnect, event effects, footer status,
  pending selection/mention/diagnostics snapshots, debug notifications, and context hook wiring.
- `connection.ts` owns undici WebSocket connect, timeout, auth header, hello request,
  hello result validation, JSON-RPC framing, and close handling.
- `config.ts` declares typed User/Workspace settings through Pi Lovely Config.
- `selection.ts` owns current IDE selection state, display formatting, snapshot schema,
  line-budgeted selected-text rendering, and notebook/cursor formatting helpers.
- `mention.ts` owns native mention event formatting, `@file` ref generation, and matching
  pending pasted refs against raw prompt text.
- `diagnostics.ts` owns full diagnostics snapshots, aggregate model-context truncation/temp-file
  persistence, and user-facing `<problems>` formatting.
- `context.ts` owns `lovely-ide.context` marker schema validation, display rendering,
  model-context injection, and marker stripping.
- `command.ts` owns `/ide` selector UI.

The extension targets Pi's Node runtime and imports `WebSocket` from `undici`.

## IDE discovery and connection

IDE servers advertise lockfiles in Pi's user config parent plus `ide`
(normally `~/.pi/ide/<port>.lock`). Discovery runs on `session_start` and in `/ide`.

Pi accepts a lockfile only when:

- filename port parses and matches `lock.port`;
- `protocol` is `pi-ide` and `version` is `1`;
- token is present;
- advisory PID is alive when present;
- Pi `cwd` equals or descends from one advertised workspace root.

Connection behavior:

- One active WebSocket at a time.
- Concurrent connection attempts are skipped/blocked.
- Connect timeout is 3s.
- Hello includes protocol version, client name/version/PID/mode, Pi session id/name,
  random connection id, subscriptions `selection`/`mention`/`diagnostics`, and workspace.
- Pi sends `session_info_changed` notifications after `hello` when Pi's session name
  changes; IDEs update the stored name for that connection.
- Hello result is validated.
- Unsupported request methods fail immediately with JSON-RPC `-32601`; unknown notifications
  are ignored.
- Messages queued after local connection close are ignored.
- IDE-initiated `ping` gets `{}`; unsupported requests get JSON-RPC `-32601`.
- Incoming `event` notifications are parsed via shared protocol helpers.
- Auto-connect and auto-reconnect are governed by persisted config.
- Session shutdown clears the captured extension context before disconnect; stale connection
  callbacks are ignored unless they belong to the current active connection.

## Selection, mentions, and model context

Selection Context is enabled by default.

IDE wire ranges are zero-based inclusive display/reference ranges. Pi displays and injects
them as 1-based line/character positions. Notebook ranges are cell-relative when `cell`
is present.

Selection events:

- Store current selection for footer, `/ide` preview, and next prompt context.
- Use first span when spans are present.
- Empty `spans` with `file` means whole file.
- Cursor selections are represented as same-position ranges.
- Non-empty selected text is stored as `TextExcerpt` when supplied.

Mention events:

- Paste a plain Pi `@` reference plus trailing space into active editor.
- Remember referenced snapshot so next eligible prompt can receive rich IDE context.
- References support files, ranges, cursors, whole notebook cells, and notebook cell ranges:
  `@file`, `@file#line:char-line:char`,
  `@file[cell id|1-based-index]`, and
  `@file[cell id|1-based-index]#line:char-line:char`.

Problems attachments:

- Receive structured diagnostics events, store full snapshots, and paste
  `[problems: path#line-range]`, `[problems: path]`, or `[problems: workspace]`
  into the Pi editor.
- Only markers retained in the next eligible prompt receive `<problems>` context.
- A newer pending snapshot replaces an older snapshot with the same marker.
- Selection-scoped snapshots contain diagnostics intersecting non-empty VS Code selections;
  their 1-based inclusive selected line ranges appear in both marker and `<problems>` metadata.
- Selection-scoped snapshots also contain bounded excerpts of the complete selected lines;
  `<selected_code>` context replaces potentially stale ambient Selection Context.
- A selection with no intersecting Problems shows an IDE notification and sends nothing.
- Workspace Problems omit empty diagnostic documents; no remaining Problems shows an IDE
  notification and sends nothing.
- Multiple selection line ranges are sent in document order for deterministic markers.
- Notebook Problems markers, metadata, and rendered diagnostic locations include cell id/index;
  selected and diagnostic lines are cell-relative.
- Without a selection the command captures all active-document diagnostics.
- A separate workspace command captures cached diagnostics for workspace documents.
- Diagnostic ranges preserve zero-based LSP half-open semantics on the wire and render as
  1-based `path:line:character [severity source code] message` lines.
- All model-visible Problems context across message history shares one Pi-standard output
  bound. It is aggregated on the latest referenced Problems message; full context is saved
  to a private temp file and its path appears in the truncation note.
- Temp-file persistence failures throw an explicit error rather than silently losing full
  Problems context.

Prompt/context flow:

- Only idle interactive/RPC prompts get rich selection context.
- `before_agent_start` stores one `lovely-ide.context` custom message when prompt has valid
  pasted IDE mentions, Problems attachments, and/or pending ambient selection.
- Context marker content is empty; structured data lives in `details`.
- Marker display is controlled by `displaySelectionMessages`.
- If ambient selection will be injected and no valid mention or selection-scoped Problems
  attachment takes precedence,
  `before_agent_start` adds one system-prompt guideline telling model that
  `<selection>`/`<cursor>` blocks may be irrelevant.
- `context` strips all extension markers and debug notifications from model messages.
- Valid mentions and Problems attachments are appended to preceding user message as
  `<mention>`/`<problems>` context.
- If message has a valid explicit mention or selection-scoped Problems attachment, ambient
  selection is skipped for that message.
- Otherwise latest ambient selection is appended as `<selection ...>...</selection>`,
  self-closed `<selection ... />`, or `<cursor ... />`.
- Steer/follow-up prompts keep only plain pasted references; no rich IDE context.

Selected text rendering:

- `selectedTextLineLimit` cycles `off`/`3`/`5`/`9` in `/ide`.
- Over-budget excerpts render head/tail with `[... N lines ... ]` or
  `[... omitted text ... ]` between.

## UI and config

Footer status key is `lovely-ide`.

- Connected: shows `● IDE`, IDE name, PID, and current cursor/selection.
- Disconnected with both auto flags off: `○ IDE disabled` muted.
- Otherwise disconnected: `○ IDE disconnected` error.
- Cursor/selection display is independent of Selection Context.

`/ide` shows a custom selector:

- Live Selection Context preview above options when Selection Context is enabled.
- Current IDE selection when connected/non-empty; example selected-code preview otherwise.
- Preview refreshes while open as native IDE selection events arrive.
- Lists discovered IDE endpoints.
- Settings opens Pi Lovely Config's scoped editor for auto-connect, auto-reconnect,
  selection context, context-message display, raw-notification debug, and selected-text
  line limit.
- User config is `~/.pi/agent/xl0-lovely-ide.json`; Workspace config is
  `<cwd>/.pi/xl0-lovely-ide.json`. Workspace values override User values, and the old
  workspace-only file maps directly to the Workspace scope.
- Includes Disconnect action.
- Connection selector uses arrows/Enter/Esc; scoped editor updates settings live.
- Current connection is pre-selected.

Debug notifications:

- Optional display-only custom messages `lovely-ide.debugNotification`.
- Show incoming IDE JSON-RPC notifications as syntax-highlighted pretty JSON.
- Truncate at 4KB.
- Stripped from model context.
- Already-rendered text is cleared when toggle is turned off.

## VS Code extension

`ide-plugins/vscode` is an ESM VS Code subpackage.

- Marketplace package name: `pi-lovely-ide`.
- Extension ID: `xl0.pi-lovely-ide`.
- VS Code engine: `^1.100.0`.
- Command: `Pi: Mention Selection` (`pi-lovely-ide.mentionSelection`).
- Commands: `Pi: Attach Problems` and `Pi: Attach Workspace Problems`.
- Default keybindings when editor text or notebook editor is focused:
  - `Alt+Shift+L`: mention selection.
  - `Alt+Shift+D`: attach Problems.
- Uses `ws`, Valibot, and shared protocol module.
- `tsc --noEmit` type-checks.
- `esbuild.mjs` bundles/minifies CommonJS output to `dist/extension.cjs`.
- `.vscodeignore` excludes source/config/deps/lockfiles/maps for VSIX packaging.
- Root `dev-install-vscode-plugin.sh [ide-cli]` installs deps, removes stale VSIX artifacts,
  packages the current plugin version, and installs through `code` by default or another
  CLI such as `cursor`.
- Root `.vscode/launch.json` runs Extension Development Host from the subpackage;
  `.vscode/tasks.json` compiles first.

Activation/runtime:

- Activates on `onStartupFinished`.
- Creates VS Code log output channel `Pi Lovely IDE`.
- Starts one localhost WebSocket server per extension host/window.
- Generates random token.
- Writes `~/.pi/ide/<port>.lock` with protocol/version/port/PID/workspaces/IDE/token.
- Updates lockfile on workspace folder changes.
- Removes own lockfile on deactivate.
- Opportunistically deletes safe stale `pi-ide` locks with dead PID.
- Validates `X-Pi-Ide-Authorization` before registering connection.
- Accepts `hello`, stores connection metadata by socket, responds to `ping`, and waits for
  future selection events instead of sending current selection on hello.

Selection publishing:

- Listens only to `onDidChangeTextEditorSelection`.
- Active editor changes, visible-range changes, and notebook-editor selection events do not
  publish ambient selections.
- Publishes text selections and cursor positions to subscribed Pi connections regardless of
  file workspace.
- Dedupe is per socket using last selection keys.
- VS Code half-open selections ending at column 0 map to previous line's last character for
  protocol ranges; text excerpts exclude that trailing newline.
- Small selected text sends full `head`.
- Large selected text sends first/last 20 selected lines, each edge capped at 2048 chars.
- Notebook cell text selections/cursors map to notebook file plus cell address plus
  cell-relative range by matching against active notebook editor.

Mention command:

- Uses active text editor selection.
- Notebook cell documents must resolve to active notebook editor cell; otherwise warns and
  sends nothing.
- If multiple subscribed Pi connections are available, uses QuickPick by latest session
  name/id/PID.
- If one target exists, sends directly.

Debug logs cover server/lockfile/connection state, listened VS Code text selection events,
and outgoing protocol summaries without raw selected text.

## Non-goals/current absences

- No model-callable IDE diagnostics tool; Problems are explicit user attachments.
- No IDE mutation/execution tool calls.
- No custom footer beyond status key.
- No notebook execution protocol yet.
- No access to raw language-server output channels/logs.
