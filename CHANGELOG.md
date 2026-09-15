# Changelog

Changes to the Pi npm package. VS Code and Obsidian adapters release independently.
Historical release dates use npm publication dates (UTC).

## [Unreleased]

### Added

- Concurrent connections to distinct IDE apps, with per-app connection controls,
  independent recovery, and latest-active selection context.
- File-level text excerpts for rendered selections, including Obsidian Reading view.
- Originating IDE names in selection and mention snapshots and context blocks;
  unknown origins remain unattributed.

### Changed

- Context messages are visible by default and follow Pi's message theme.
- The footer highlights the context source; process details remain in `/ide`.
- npm releases use reviewed changelog/version updates, `v`-prefixed tags, and
  GitHub Actions staging with OIDC provenance and manual 2FA approval.

### Fixed

- Inclusive one-character selections are no longer mistaken for cursors.
- Async IDE callbacks cannot use invalidated contexts after session replacement.

## [0.3.4] - 2026-07-24

### Added

- Preserve past selection context by default for prompt-cache stability, with
  a setting to retain only the latest selection instead.

### Fixed

- Notebook references and diagnostics consistently use zero-based cell indices.

## [0.3.3] - 2026-07-21

### Added

- User and workspace settings through Pi Lovely Config, with workspace overrides
  and a scoped settings editor in `/ide`.

## [0.3.2] - 2026-07-21

### Added

- Explicit Problems attachments carrying diagnostics, selected code, and notebook
  cell locations, with bounded model context and private full-output files.

## [0.3.1] - 2026-06-30

### Added

- Initial npm release of the Pi IDE integration: ambient selections, file and
  notebook mentions, and session-name updates over the local IDE protocol.
