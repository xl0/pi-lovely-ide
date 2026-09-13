# pi-lovely-ide

Connect [Pi](https://github.com/earendil-works/pi) to your IDE. Pi sees what you have
selected in the editor, and you can send it code ranges and diagnostics with a keystroke —
no copy-pasting file paths, line numbers, or compiler errors into the prompt.

The integration consists of:

- **`@xl0/pi-lovely-ide`** (this package) — a Pi extension that discovers IDE servers,
  maintains connections, and turns IDE events into model context.
- **[Pi Lovely IDE](https://marketplace.visualstudio.com/items?itemName=xl0.pi-lovely-ide)**
  (`xl0.pi-lovely-ide`) — a VS Code extension that publishes editor state over the
  [Pi IDE Protocol](./docs/PI_IDE_PROTOCOL.md). Lives in this repo under
  [`ide-plugins/vscode`](./ide-plugins/vscode), distributed separately through the Marketplace.
- **[Obsidian plugin](./ide-plugins/obsidian)** — note/selection context and explicit
  mentions for desktop vaults, distributed as GitHub release assets.

## What you get

- **Selection context** — Pi's footer live-tracks your cursor and selection. When you submit
  a prompt, the latest-active IDE's selection (with a bounded excerpt of the selected text) is attached
  as context, so "why is this wrong?" just works.
- **Mentions** — `Alt+Shift+L` in VS Code pastes an `@file#range` reference into Pi's input.
  The model gets the referenced code alongside your prompt.
- **Problems attachments** — `Alt+Shift+D` pastes a `[problems: …]` marker carrying the
  diagnostics under your selection (or the whole file; a separate command attaches all
  workspace Problems). The model sees the diagnostics and the selected code they belong to.
- **Notebook support** — selections, mentions, and Problems in notebook cells carry the cell
  id/index and cell-relative line numbers.
- **`/ide`** — connection controls and live preview: connect/disconnect each IDE or open scoped settings for
  auto-connect, auto-reconnect, selection context/history, context-message display, debug
  logging of raw IDE events, and the selected-text line budget.

## Setup

1. Install the VS Code extension: search for **Pi Lovely IDE** in the Marketplace, or

   ```bash
   code --install-extension xl0.pi-lovely-ide
   ```

2. Install the Pi package:

   ```bash
   pi install npm:@xl0/pi-lovely-ide
   ```

   Or load it for a single session without installing:

   ```bash
   pi -e npm:@xl0/pi-lovely-ide
   ```

3. Start Pi in a folder that is (or is inside) a workspace folder open in VS Code.
   Pi auto-connects on startup; if it doesn't, run `/ide` and pick the endpoint.
   The footer shows `● IDE` with the IDE name once connected.

Settings support User (`~/.pi/agent/xl0-lovely-ide.json`) and Workspace
(`<workspace>/.pi/xl0-lovely-ide.json`) scopes. Workspace values override User values.

### Obsidian setup

Requires **Obsidian desktop 1.13.7+** and Pi; mobile is not supported. This is the
currently exercised compatibility floor, not a claim that older versions cannot work.
The plugin has not yet been listed in Community plugins.

- Until the first release, use the [local installer](#development).
- Once published, download `main.js` and `manifest.json` from an Obsidian plugin
  [release](https://github.com/xl0/pi-lovely-ide/releases) (tagged `x.y.z`).
  Put both files in `<vault>/.obsidian/plugins/pi-lovely-ide/`, then enable
  **Pi Lovely IDE** in Settings → Community plugins.
- For beta updates, [BRAT](https://tfthacker.com/BRAT) can install this repository
  after its first release is published.

The published Pi package `0.3.4` predates the Obsidian integration. Until an updated
npm version is released, start Pi inside your vault with this checkout loaded:

```bash
pi -e /absolute/path/to/pi-lovely-ide
```

Run **Pi: Mention Selection** or **Pi: Mention Whole Note** from Obsidian's command
palette. **Alt+Shift+L** defaults to Mention Selection, matching VS Code; override it
in Settings → Hotkeys. With multiple Pi sessions, choose which one receives the mention.

### Obsidian and VS Code together

Open the same project in VS Code and as an Obsidian vault, then run Pi in that directory
(or a subdirectory). One matching endpoint per app connects automatically. Multiple
matching windows of the same app require an explicit `/ide` choice.

The last app you focus or use supplies ambient selection context. Background updates
and window blur do not replace it. Explicit mentions work from either app. The footer
highlights the current context source as `[App]` and dims other connected apps.
PIDs remain available in `/ide` rather than cluttering the footer.
Selection and mention context blocks retain their originating app as `ide="Obsidian"`
(or the other IDE's name), even after switching apps.

With **Auto-reconnect and discover** enabled, Pi also finds apps opened later.
Disconnecting an app in `/ide` suppresses its automatic connection until you reconnect
it manually or reload/restart the Pi session. **Disconnect all** also pauses discovery.
Disconnecting the context source clears ambient context until another app publishes
activity; disconnecting an inactive app leaves the current context alone.

Obsidian's Reading view sends selected rendered text with the note reference, without
guessed source positions. This works for ambient context and **Pi: Mention Selection**;
**Pi: Mention Whole Note** omits the excerpt.

Release preparation and directory submission are documented in the
[Obsidian release instructions](#obsidian).

### Privacy and external services

The adapter sends note paths, cursor/range information, and bounded selected-text
excerpts to subscribed Pi sessions over an authenticated loopback WebSocket. It does
not send data directly to an internet service and has no telemetry.

When you submit a prompt, Pi may send that context to your configured AI provider
(for example OpenAI, Anthropic, or Google), or to a local model. Provider accounts,
API credentials, charges, and data handling depend on your Pi configuration; the
Obsidian plugin has no separate account or subscription requirement.

The plugin reads/writes discovery lockfiles outside the vault in `~/.pi/ide`
(or the parent of `PI_CODING_AGENT_DIR`, plus `ide`). It does not edit note contents.
Pi may retain captured context in its session history. To stop ambient attachment,
disable **Selection context** in `/ide` settings; disconnect Obsidian in `/ide` or
disable the plugin to stop the connection. Removing a pasted mention does not disable
ambient selection context.

## How it works

Each VS Code window or Obsidian vault runs a small WebSocket server on localhost and
advertises it through a lockfile. Pi discovers matching servers and connects to distinct
apps independently.

```text
  VS Code window                                     Pi session
┌──────────────────────────┐                   ┌──────────────────────────┐
│ Pi Lovely IDE extension  │                   │ @xl0/pi-lovely-ide       │
│                          │    selection      │                          │
│ WebSocket server         │    mention        │ footer status            │
│ on 127.0.0.1:<port> ─────┼──── diagnostics ─▶│ @refs and [problems]     │
│        │                 │     events        │ model context            │
└────────┼─────────────────┘                   └────────────▲─────────────┘
         │ writes                                           │
         ▼                                    discovers and │ connects
  ~/.pi/ide/<port>.lock   ──────────────────────────────────┘
  (protocol, port, token, workspaces, PID)
```

**Discovery and auth.** The lockfile carries the protocol version, port, a random
per-server token, and the window's workspace folders. Pi only accepts a lockfile when the
protocol/version match, the advertised process is alive, and Pi's cwd equals or descends
from one of the workspace roots. The connection is authenticated with the token and starts
with a `hello` handshake declaring which events Pi wants (`selection`, `mention`,
`diagnostics`). This transport stays on localhost; submitted model context follows
Pi's provider configuration as described above.

**From event to model context.** Selection events only update Pi's footer and a pending
snapshot — nothing reaches the model until you submit a prompt. Mention and Problems events
paste a plain-text reference into Pi's input; the rich context (referenced code,
diagnostics, selected lines) is attached only if that reference is still present in the
prompt you actually submit. Delete the marker and nothing extra is sent. If you mention a
range explicitly, the ambient selection is skipped for that prompt so the model doesn't get
the same code twice.

Context is injected as `<selection>`, `<mention>`, and `<problems>` blocks appended to your
message, and the bookkeeping markers are stripped from what the model sees. Aggregate
Problems context is capped at Pi's standard output limit; when it overflows, the full text
is written to a private temp file and the model gets the path.

By default, ambient selection context remains on earlier messages, keeping prompt-cache
prefixes stable at the cost of retaining those input tokens. Disable **Keep past selection
context** in `/ide` settings to keep only the latest available ambient selection block;
that block remains until a newer selection replaces it.

## Protocol docs

- [`PI_IDE_PROTOCOL.md`](./docs/PI_IDE_PROTOCOL.md) — canonical pi-native protocol.
- [`CC_IDE_PROTOCOL.md`](./docs/CC_IDE_PROTOCOL.md) — historical Claude Code IDE protocol reference only.

## Development

Pi package:

```bash
bun install
bun install --cwd ide-plugins/vscode
bun install --cwd ide-plugins/obsidian
bun run check
pi -e .
```

VS Code plugin (`ide-plugins/vscode`):

```bash
cd ide-plugins/vscode
bun install
bun run compile
```

Debug from this repo with VS Code's `Run VS Code Extension` launch config. It compiles the
plugin, opens an Extension Development Host, starts a local Pi IDE Protocol server, and
writes `~/.pi/ide/<port>.lock`. To package and install the plugin into your regular VS Code
(or another CLI such as `cursor`):

```bash
./dev-install-vscode-plugin.sh [ide-cli]
```

Obsidian plugin:

```bash
./dev-install-obsidian-plugin.sh /absolute/path/to/vault
# Automatically enable/reload through Obsidian CLI, targeting an explicit vault name/ID:
./dev-install-obsidian-plugin.sh /absolute/path/to/vault "My Vault"
```

With the second argument, the installer enables the plugin if disabled, or reloads
it if already enabled. With only a path, enable **Pi Lovely IDE** manually in
Obsidian's Community plugins settings. Start Pi
inside the vault with this checkout loaded (`pi -e /absolute/path/to/pi-lovely-ide`).
Rebuild/reinstall the VS Code plugin too for focus-aware selection publishing, and
`/reload` an existing Pi session to load the multi-IDE client.

The installer copies plugin artifacts and optionally manages activation through the CLI;
it never edits notes or vault settings files directly.
See [Obsidian development notes](./ide-plugins/obsidian/README.md) for limitations.
Root checks cover both adapters and the multi-IDE client. Connection tests run under
Node (Pi's runtime), with Bun used to bundle their TypeScript.

Manual smoke test:

1. Launch `Run VS Code Extension`.
2. In the Extension Development Host, open a project folder.
3. Run Pi in the same project with this package loaded: `pi -e .`.
4. Use `/ide` if auto-connect did not connect.
5. Select text in VS Code; Pi footer should show the file/range.
6. Run `Pi: Mention Selection`; Pi input should receive `@file#x-y`.
7. Run `Pi: Attach Problems`; Pi input should receive `[problems: path#line-range]`.

## Releasing

The three packages have independent versions and release paths:

| Package | Version source | Release |
| --- | --- | --- |
| Pi npm package | Root `package.json` | `bun run release [patch\|minor\|major\|x.y.z] [--no-push]` |
| VS Code / Open VSX | `ide-plugins/vscode/package.json` | Subpackage `release` / `release:openvsx` |
| Obsidian | Root `manifest.json` | Plain `x.y.z` tag → draft GitHub release |

### Pi npm package

Write user-facing entries under [`CHANGELOG.md`](./CHANGELOG.md)'s `[Unreleased]`
section (`Added`, `Changed`, `Fixed`, `Removed` as needed), then commit them.
From `master`, with Bun 1.3.13 and npm 12.0.2 (logged in):

```sh
bun run release minor
# Or prepare only the local release commit and tag:
bun run release minor --no-push
```

Following the Lovely Web/Config flow, the script checks versions and registry state,
runs `prepublishOnly` and a package dry run, rolls the changelog into a dated release,
and bumps **only root `package.json`**. It pauses for review before committing those
two files and creating `vX.Y.Z`. Unrelated changes are left alone.

By default it pushes and waits for `.github/workflows/publish.yml` to stage the npm
package with OIDC provenance and create a changelog-based GitHub Release. It then asks
for a 2FA code to approve publication. `--no-push` stops after the local commit/tag.
Configure npm's GitHub Actions trusted publisher for `xl0/pi-lovely-ide`, workflow
`publish.yml`, environment `npm`; create that GitHub environment too. No npm token
is needed in CI.

`v`-prefixed tags belong to npm and do not trigger the Obsidian workflow. The script
does not change adapter versions or publish either adapter.

### VS Code and Open VSX

Update the adapter's version independently, then run the desired publisher:

```sh
bun run --cwd ide-plugins/vscode release          # VS Code Marketplace
bun run --cwd ide-plugins/vscode release:openvsx  # Open VSX
```

These use `vsce publish` and `ovsx publish`, respectively, and source the adapter's
git-ignored `.env` for `VSCE_PAT` / `OVSX_PAT`. The `vscode:prepublish` hook type-checks
and builds the production bundle. There is currently no tag-triggered adapter publish.

### Obsidian

The repository-root [`manifest.json`](./manifest.json) is the canonical Obsidian
manifest and version source. The adapter's private `package.json` is build-only.
The installer and release workflow use the root manifest directly; do not maintain
a second copy in the adapter.

1. Update the root manifest's `version` for each release. It must be plain `x.y.z`,
   with no `v` or adapter prefix. `minAppVersion` is conservatively set to 1.13.7,
   the exercised desktop version; lower it only after testing older versions.
2. Run `bun run check` from the repository root. Merge the release changes into the
   default branch so Obsidian's directory sees the correct manifest.
3. Push the matching tag, for example for the initial release:

   ```sh
   git tag -a 0.1.0 -m "Obsidian plugin 0.1.0"
   git push origin 0.1.0
   ```

4. [Release Obsidian plugin](./.github/workflows/release-obsidian.yml) validates
   the tag, installs dependencies with Bun, runs the checks/build, and creates a
   **draft** GitHub release with `main.js` and `manifest.json` attached. Review the
   release and publish it. No separate release secret is needed; it uses `GITHUB_TOKEN`.
5. For the first listing, sign in at [community.obsidian.md](https://community.obsidian.md/),
   link GitHub, and submit `https://github.com/xl0/pi-lovely-ide`. Address review
   feedback before publication. Subsequent versions only need new GitHub releases.

The first release and directory submission are still pending. The Pi npm package
also needs an updated release: published `0.3.4` predates this integration. Until then,
beta testers must load the Pi side from a checkout as described in [Obsidian setup](#obsidian-setup).
Do not reuse published versions/tags. If the plugin gains `styles.css`, add it to
the workflow's release assets as well as the local install.

The build includes the project's MIT license and the bundled `ws` and Valibot license
notices in `main.js`, since Obsidian installs release assets rather than the repository.

References: [publishing guide](https://docs.obsidian.md/plugins/releasing/submit-plugin),
[developer policies](https://docs.obsidian.md/community-directory/developer-policies).

## Related projects

|  |  |
| --- | --- |
| [Pi Lovely Web](https://github.com/xl0/pi-lovely-web) | `web_search`, `web_fetch`, `web_image` tools |
| [Pi Lovely Dev Tools](https://github.com/xl0/pi-lovely-dev-tools) | interactive debugging helpers `/tool`, `/show-sysprompt`, `/show-context`, `/llm-stats` |
| [Pi Lovely Codex](https://github.com/xl0/pi-lovely-codex) | GPT fast mode and Codex-style `apply_patch` |
| [Pi Lovely Config](https://github.com/xl0/pi-lovely-config) | Scoped config (User/Workspace) library for Pi extensions |
| [Pi Lovely Comment](https://github.com/xl0/agent-files/tree/master/pi/packages/pi-lovely-comment) | open the last assistant message in your editor and sync edits back into the prompt |
| [Pi Lovely Rename](https://github.com/xl0/agent-files/tree/master/pi/packages/pi-lovely-rename) | automatic and manual session naming |

---

Like this work? [Hire me](https://alexey.work/cv?ref=pi-lovely-ide)
