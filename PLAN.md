# Plan

Bridge Pi with IDEs over the pi-native Pi IDE Protocol: ambient selection context,
explicit mentions, and explicit Problems attachments, with a VS Code plugin as the
first IDE implementation. Canonical protocol spec is `docs/PI_IDE_PROTOCOL.md`;
current behavior is recorded in `CODE.md`.

## [x] Done (compacted)

- [x] Pi IDE Protocol v1: JSON-RPC-lite over local WebSocket; lockfile discovery with
      token auth and advisory PID cleanup; `hello` with session/connection/subscriptions;
      one `event` method carrying `selection`/`mention`/`diagnostics`; unknown requests
      fail with `-32601`; zero-based inclusive spans with `TextExcerpt` head/tail excerpts.
- [x] VS Code plugin (`ide-plugins/vscode`): WS server + lockfile per window, selection
      publishing from focused editor activity, `Pi: Mention Selection`,
      notebook cell-relative spans, QuickPick targeting, debug log channel.
- [x] Pi extension on native protocol: discovery/reconnect, footer status, `/ide` UI,
      scoped User/Workspace settings, ambient selection context with configurable history,
      mention context, context messages visible by default, `session_info_changed`.
- [x] IDE Problems: explicit attach commands (selection/file/workspace) with markers,
      LSP half-open ranges preserved, notebook cell id/index, bounded selected-code
      excerpts, empty-attachment notifications, one global model-context cap across
      history with full output saved to a temp file on truncation.
- [x] Automated verification: root/VS Code typechecks, Biome, bundle compile, context smoke test.

## Manual verification

- [ ] Extension Development Host test against live language-server diagnostics.
- [ ] Both Problems attachment commands and resulting model context after extension reload.
- [ ] Connect, footer status, ambient selection context, mention command, multi-selection,
      multiple Pi sessions target picker, stale lock cleanup.

## Obsidian and concurrent IDEs

Build an Obsidian desktop adapter on the existing Pi protocol, independently of the
notebook branch. Let distinct apps serving the same directory coexist. Ambient
context follows latest user activity; explicit mentions work from either app.

- [x] Per-app connections, latest-active context, focus-aware publishing, and independent recovery.
- [x] Obsidian note/selection/mention plugin and vault-local installer with optional CLI enable/reload.
- [x] Distinct context-source badge in the footer; process details stay in `/ide`.
      Selection/mention snapshots and context blocks retain the originating IDE name.
- [x] Reading-view selection/mentions carry rendered excerpts without guessed source positions.
- [x] Lifecycle/range tests (including newline-only boundaries), bundle-level protocol
      smoke test, Obsidian production build in root checks, and scratch-vault install checks.
- [x] Synchronous unload unadvertising and closed-port cleanup prevent stale Obsidian entries.
- [ ] Live Obsidian + VS Code testing in a chosen vault.
- [ ] Refine selection and disable/disconnect UX after the initial implementation.

## Marketing assets

- [ ] Record a better demo video, then advertise it to the pi.dev package gallery through
      `pi.video` in `package.json` (mp4, must be served with `video/mp4` — raw GitHub URLs
      are `application/octet-stream`, jsDelivr works). Current `demo.mp4` is not good enough.

## Notebook follow-ups still open

- [ ] Notebook execution protocol namespace (`notebook/*`) and whether it belongs in v2 or separate doc.
- [ ] Notebook execution address model beyond selection/mention spans: path + stable cell id + index fallback is likely.
- [ ] Notebook execution result model: return final cell outputs/status first; streaming optional later.
