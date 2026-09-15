# Codebase

## Overview

`@xl0/pi-lovely-ide` is a Pi package that bridges Pi with IDEs over the Pi IDE Protocol.

- Published npm package includes:
  - Pi extension in `extensions/lovely-ide/`.
  - Shared protocol module in `packages/protocol/src/`.
- IDE adapters live in `ide-plugins/vscode/` and `ide-plugins/obsidian/`.
- Canonical protocol doc: `docs/PI_IDE_PROTOCOL.md`.
- `docs/CC_IDE_PROTOCOL.md` is historical Claude Code reference only.
- `archive/IDE_DIAGNOSTICS_TOOL.md` records the removed model-pulled diagnostics design.
- Root TS config is strict, including `exactOptionalPropertyTypes`.
- Root checks cover Pi, both IDE adapters, focused regression tests, and the
  Obsidian production bundle.
- Biome allowlists source, tests, and config/build files; generated artifacts are outside its scope.
- Runtime validation uses Valibot in shared protocol and extension-local state.
- Pi peer/dev dependency is `@earendil-works/pi-coding-agent` `^0.80.10` for
  typed `session_info_changed` support.
- Scoped settings use `@xl0/pi-lovely-config`.

## Releases

- Root `CHANGELOG.md` follows the Lovely Web/Config format: `[Unreleased]`, then
  dated version sections with Added/Changed/Fixed/Removed entries. It covers npm.
- `scripts/release.ts` manages only that changelog and root `package.json`.
  From master it verifies, rolls/bump versions, asks for approval, then commits only
  those files and tags `vX.Y.Z`. `--no-push` stops locally; otherwise it pushes,
  waits for npm staging, and prompts for 2FA approval. Unrelated staged work is excluded.
- `.github/workflows/publish.yml` checks tag/version, runs verification, stages the
  npm package with OIDC provenance, and creates a changelog-based GitHub Release.
  It needs the GitHub `npm` environment and matching npm trusted-publisher configuration.
- `prepublishOnly` runs root checks; the npm file allowlist excludes adapter code
  and the root Obsidian manifest. Adapter versions/publish paths remain independent.
- npm uses `v`-prefixed tags; Obsidian uses bare version tags. VS Code/Open VSX
  publishing remains manual through the adapter's package scripts.
- Maintainer release instructions for all components live in root `README.md`;
  the Obsidian adapter README omits publishing procedures.

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

- `index.ts` owns lifecycle, IDE discovery, event effects, footer status,
  pending selection/mention/diagnostics snapshots, debug notifications, and context hook wiring.
- `connections.ts` owns per-app connection state, automatic discovery/recovery,
  manual-disconnect suppression, and latest-active selection ownership.
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
(normally `~/.pi/ide/<port>.lock`). Discovery runs on startup, in `/ide`, and every
second while automatic recovery/discovery is enabled, including while connected.

Pi accepts a lockfile only when:

- filename port parses and matches `lock.port`;
- `protocol` is `pi-ide` and `version` is `1`;
- token is present;
- advisory PID is alive when present;
- Pi `cwd` equals or descends from one advertised workspace root.

Connection behavior:

- One connection per advertised `ide` name (unnamed endpoints share the `IDE` group).
  Distinct apps connect concurrently; PID is not identity because vaults/windows may share it.
- Multiple matching endpoints of the same app require an explicit `/ide` choice.
  A remembered endpoint may reconnect when its port/token still match.
- Handshakes and recovery are independent. A new connection does not take selection ownership.
- Per-app manual disconnect suppresses reconnection until explicit connect or session reload/start.
  Disconnect all also pauses discovery. Neither changes persisted config.
- Connect timeout is 3s.
- Hello includes protocol version, client name/version/PID/mode, Pi session id/name,
  random connection id, subscriptions `selection`/`mention`/`diagnostics`, and workspace.
- Pi broadcasts `session_info_changed` to connected IDEs when its session name changes.
- Hello result is validated.
- Unsupported request methods fail immediately with JSON-RPC `-32601`; unknown notifications
  are ignored.
- Messages queued after local connection close are ignored.
- IDE-initiated `ping` gets `{}`; unsupported requests get JSON-RPC `-32601`.
- Incoming `event` notifications are parsed via shared protocol helpers.
- Auto-connect and auto-reconnect are governed by persisted config.
- Session shutdown closes established and pending connections. Discovery generations fence
  async results from old sessions, and callbacks must belong to a retained connection.
- Captured contexts are probed before async callback use; a stale context stops the old pool
  instead of throwing outside Pi's handler boundary.

## Selection, mentions, and model context

Selection Context is enabled by default.

Selection/mention snapshots capture the originating connection's IDE name in `ide`.
Context blocks include it as an escaped `ide="..."` attribute; plain references do not.
Attribution is captured on receipt and survives focus changes, disconnects, and history
serialization. Missing or blank origins omit the field; the UI's generic `IDE`
label is never used as fabricated provenance.

IDE wire ranges are zero-based inclusive display/reference ranges. Pi displays and injects
them as 1-based line/character positions. Notebook ranges are cell-relative when `cell`
is present.

Selection events:

- Each connection retains its selection; only the latest active source supplies the footer,
  `/ide` preview, and next prompt context. Producers publish only while focused, including
  on focus gain and new hello, so background updates and blur cannot steal context.
- Disconnecting the active source clears ambient context until another activity event.
  Disconnecting an inactive source preserves the current selection.
- Use first span when spans are present.
- Empty `spans` with `file` means a file reference; optional top-level `text` carries
  selected text without source coordinates (e.g. a rendered reading-view excerpt).
  File-level text is rejected alongside spans or a null file.
- Same-position ranges without selected text are cursors; text disambiguates
  one-character selections in the inclusive wire format.
- Newline-only selections retain their newline excerpt and use the preceding line's
  end position for both endpoints, instead of becoming inverted ranges or cursors.
- Non-empty selected text is stored as `TextExcerpt` when supplied.

Mention events:

- Paste a plain Pi `@` reference plus trailing space into active editor.
- Remember referenced snapshot so next eligible prompt can receive rich IDE context.
- References support files, ranges, cursors, whole notebook cells, and notebook cell ranges:
  `@file`, `@file#line:char-line:char`,
  `@file[cell id|zero-based-index]`, and
  `@file[cell id|zero-based-index]#line:char-line:char`.

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
  cell indices are zero-based, while selected and diagnostic lines are cell-relative and
  rendered 1-based.
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
- Marker display is controlled by `displaySelectionMessages`, enabled by default.
- Displayed context and debug messages use the active theme's custom-message background
  and follow Pi's `outputPad` setting when supported by the host; older hosts retain
  their default one-column padding.
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
- `keepPastSelectionContext` optionally preserves ambient selection blocks on their original
  user messages for prompt-cache stability and defaults to enabled. Disabling it keeps only
  the latest block to avoid confusing the model with stale selections.
- Steer/follow-up prompts keep only plain pasted references; no rich IDE context.

Selected text rendering:

- `selectedTextLineLimit` cycles `off`/`3`/`5`/`9` in `/ide`.
- Over-budget excerpts render head/tail with `[... N lines ... ]` or
  `[... omitted text ... ]` between.

## UI and config

Footer status key is `lovely-ide`.

- Connected: shows `● IDE`, connected app names, and latest cursor/selection.
  The context source has a highlighted `[App]` badge; other apps are dimmed.
  PIDs appear in `/ide`, not the footer.
- Disconnected with both auto flags off: `○ IDE disabled` muted.
- Otherwise disconnected: `○ IDE disconnected` error.
- Cursor/selection display is independent of Selection Context.

`/ide` shows a custom selector:

- Live Selection Context preview above options when Selection Context is enabled.
- Current IDE selection when connected/non-empty; example selected-code preview otherwise.
- Preview refreshes while open as native IDE selection events arrive.
- Lists discovered and connected endpoints with per-app Connect/Disconnect actions.
- Settings opens Pi Lovely Config's scoped editor for auto-connect, auto-reconnect,
  selection context/history, context-message display, raw-notification debug, and
  selected-text line limit.
- User config is `~/.pi/agent/xl0-lovely-ide.json`; Workspace config is
  `<cwd>/.pi/xl0-lovely-ide.json`. Workspace values override User values, and the old
  workspace-only file maps directly to the Workspace scope.
- Includes Disconnect all action.
- Connection selector uses arrows/Enter/Esc; scoped editor updates settings live.
- Current context source is pre-selected and labelled `(context)`.

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
- Marketplace icon `assets/icon.png` (256px) is rendered from `assets/logo.svg`
  (official Pi mark with its "i" block replaced by a heart) via
  `inkscape -w 256 -h 256 assets/logo.svg -o assets/icon.png`.
- Uses `ws`, Valibot, and shared protocol module.
- `tsc --noEmit` type-checks.
- `esbuild.mjs` bundles/minifies CommonJS output to `dist/extension.cjs`.
- `.vscodeignore` excludes source/config/deps/lockfiles/maps/dev docs for VSIX packaging.
- `bun run release` publishes to the VS Code Marketplace, `bun run release:openvsx` to
  Open VSX. Both scripts source git-ignored `ide-plugins/vscode/.env` (`VSCE_PAT`,
  `OVSX_PAT`) themselves, because `bun run` does not pass Bun's auto-loaded `.env` values
  to spawned binaries. Without `VSCE_PAT`, `vsce` silently falls back to its keyring-stored
  PAT and never checks its expiry.
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
- Accepts `hello`, stores connection metadata, responds to `ping`, and publishes the
  current selection on hello only when the IDE window is focused.

Selection publishing:

- Publishes focused active-editor selection, document, and editor changes.
  Window focus gain republishes even an unchanged selection; blur sends nothing.
- Publishes text selections and cursor positions to subscribed Pi connections regardless of
  file workspace.
- Dedupe is per socket using last selection keys.
- VS Code half-open selections ending at column 0 map to previous line's last character for
  protocol ranges; text excerpts exclude that trailing newline unless it is the entire selection.
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

## Obsidian desktop plugin

`ide-plugins/obsidian` bundles `ws`, Valibot, and the shared protocol into CommonJS
`main.js`; Obsidian and CodeMirror remain host-provided externals.
Like VS Code, bundled libraries are declared as dev dependencies; installed
plugins require no separate dependency installation.

- Repository-root `manifest.json` is the canonical plugin metadata/version source.
  It declares desktop-only support and a conservative minimum of Obsidian 1.13.7.
  Vault root is its advertised workspace; the adapter package is private/build-only.
- Source/live-preview selections map Obsidian's half-open positions to inclusive spans.
  Excerpts use bounded head/tail chunks. Reading view sends the note reference plus
  selected rendered text, never invented source positions. DOM selections must be
  contained in the active reading pane; sidebars and other notes are excluded.
- Reading-view changes use a DOM selection listener plus focused 300ms polling because
  reading panes do not reliably deliver selection events. Both paths dedupe per connection.
- Focus-aware editor hooks publish note/cursor/selection; active non-Markdown views clear it.
- `Pi: Mention Selection` and `Pi: Mention Whole Note` target a connected Pi session,
  with a chooser when several subscribe. Captured targets cannot send after plugin unload.
  Mention Selection defaults to Alt+Shift+L; users can override it in Obsidian's Hotkeys.
- Loopback authentication, hello/session metadata, subscriptions, and private atomic lockfiles
  use Pi IDE v1, with an optional file-level excerpt field. No diagnostics or notebook execution.
- Unload fences in-flight startup and removes the lockfile synchronously before
  awaiting socket shutdown. Shutdown still runs if lock removal fails; unload errors
  are logged. Obsidian does not await unload hooks.
- Startup also reaps its own PID's Obsidian lockfiles whose ports refuse connections, even if the
  renderer PID survived a reload. Live ports and uncertain failures are preserved;
  filename/port agreement and unchanged contents guard deletion.
- `dev-install-obsidian-plugin.sh <absolute-vault-path> [vault-name-or-id]` builds and copies
  artifacts into `.obsidian/plugins/pi-lovely-ide`. An explicit second argument queries
  enabled plugins through the CLI, enabling a disabled plugin or reloading an enabled one.
  Without it, activation is manual. Notes and vault settings files are never edited directly;
  Restricted mode is not disabled. CLI failures surface explicitly.
- The installer uses the root manifest and built `ide-plugins/obsidian/main.js`.
  The bundle embeds MIT notices for this project, `ws`, and Valibot.
- `.github/workflows/release-obsidian.yml` handles plain `x.y.z` tag pushes, rejects
  tag/manifest mismatches, runs root checks on Node 24/Bun, and creates a draft release
  with the two installation assets. Publishing the draft and first Community directory
  submission are manual. Pi's npm release is separate; published `0.3.4` lacks these changes.

Root `bun run test` bundles connection tests with Bun and runs them under Node, matching
Pi's runtime; Undici handshakes stalled when those tests ran directly in Bun.
Network tests cover simultaneous apps, initial selection, late discovery, disconnect/recovery,
and session replacement. Obsidian tests cover unload/stale-lock cleanup, source-range conversion, and file-level
excerpt validation/rendering through both selection and mention context.
The built Obsidian bundle also passed a host-stub/real-WebSocket smoke test for auth,
hello/selection, focus, mentions, reading view, and unload/lock cleanup.
Live Obsidian/VS Code coexistence still needs testing in a user-selected vault.

## Non-goals/current absences

- No model-callable IDE diagnostics tool; Problems are explicit user attachments.
- No IDE mutation/execution tool calls.
- No custom footer beyond status key.
- No notebook execution protocol yet.
- No access to raw language-server output channels/logs.
