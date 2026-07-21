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
      publishing from text-editor selection events only, `Pi: Mention Selection`,
      notebook cell-relative spans, QuickPick targeting, debug log channel.
- [x] Pi extension on native protocol: discovery/reconnect, footer status, `/ide` UI,
      ambient selection context, mention context, `session_info_changed`.
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

## Notebook follow-ups still open

- [ ] Notebook execution protocol namespace (`notebook/*`) and whether it belongs in v2 or separate doc.
- [ ] Notebook execution address model beyond selection/mention spans: path + stable cell id + index fallback is likely.
- [ ] Notebook execution result model: return final cell outputs/status first; streaming optional later.
