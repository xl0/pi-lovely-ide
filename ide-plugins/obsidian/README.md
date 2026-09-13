# Pi Lovely IDE for Obsidian

Obsidian desktop plugin for Pi IDE Protocol v1.

Requires Obsidian desktop 1.13.7+ and Pi with this IDE integration loaded. See
[setup and privacy disclosures](../../README.md#obsidian-setup) before using it.

- Starts authenticated localhost WebSocket server.
- Advertises vault root as Pi workspace in `~/.pi/ide/<port>.lock`.
- Removes its lock immediately on unload; startup clears closed-port records left by
  renderer reloads under the same PID, while preserving live endpoints.
- Publishes active Markdown note selection/cursor to connected Pi sessions while Obsidian window is focused.
- Commands:
  - `Pi: Mention Selection`
  - `Pi: Mention Whole Note`
- **Alt+Shift+L** defaults to Mention Selection; customize it in Settings → Hotkeys.

Reading view sends selected rendered text with the note reference, without source line
numbers. Ambient context and `Pi: Mention Selection` preserve that bounded excerpt;
`Pi: Mention Whole Note` deliberately omits it. With no selection, only the note is sent.
Source/live-preview mode retains precise source ranges.

No diagnostics or notebooks are implemented.

## Build

```sh
bun install
bun run typecheck
bun run build
```

## Local install

From repo root:

```sh
./dev-install-obsidian-plugin.sh /absolute/path/to/vault
```

With only a path, enable `Pi Lovely IDE` manually in Obsidian: Settings → Community plugins → Installed plugins.

To install and activate automatically via Obsidian CLI:

```sh
./dev-install-obsidian-plugin.sh /absolute/path/to/vault "vault-name-or-id"
```

The installer queries enabled community plugins in that vault, then enables
`pi-lovely-ide` if disabled (including first install), or reloads it if already enabled:

```sh
obsidian vault="vault-name-or-id" plugin:enable id=pi-lovely-ide filter=community
# On subsequent installs while enabled:
obsidian vault="vault-name-or-id" plugin:reload id=pi-lovely-ide
```

`vault=` must precede the command. CLI activation requires an Obsidian installer 1.12.7+,
Settings → General → Command line interface enabled, and Community plugins allowed.
CLI errors fail the install command; the installer never edits `community-plugins.json`
directly or disables Restricted mode.

## Publishing

The repository-root [`manifest.json`](../../manifest.json) is the canonical Obsidian
manifest and version source. The adapter's private `package.json` is build-only.
The installer and release workflow use the root manifest directly; do not maintain
a second copy here.

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

4. [Release Obsidian plugin](../../.github/workflows/release-obsidian.yml) validates
   the tag, installs dependencies with Bun, runs the checks/build, and creates a
   **draft** GitHub release with `main.js` and `manifest.json` attached. Review the
   release and publish it. No separate release secret is needed; it uses `GITHUB_TOKEN`.
5. For the first listing, sign in at [community.obsidian.md](https://community.obsidian.md/),
   link GitHub, and submit `https://github.com/xl0/pi-lovely-ide`. Address review
   feedback before publication. Subsequent versions only need new GitHub releases.

The first release and directory submission are still pending. The Pi npm package
also needs an updated release: published `0.3.4` predates this integration. Until then,
beta testers must load the Pi side from a checkout as described in the root README.
Do not reuse published versions/tags. If the plugin gains `styles.css`, add it to
the workflow's release assets as well as the local install.

The build includes the project's MIT license and the bundled `ws` and Valibot license
notices in `main.js`, since Obsidian installs release assets rather than the repository.

References: [publishing guide](https://docs.obsidian.md/plugins/releasing/submit-plugin),
[developer policies](https://docs.obsidian.md/community-directory/developer-policies).
