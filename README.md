# lovely-ide

Pi package for the Lovely IDE integration extension.

## How it works

`@xl0/pi-lovely-ide` is the Pi-side package. The IDE-side plugin is distributed separately through the VS Code Marketplace.

## Install Pi package

```bash
pi install npm:@xl0/pi-lovely-ide
```

Or load without installing:

```bash
pi -e npm:@xl0/pi-lovely-ide
```

## VS Code plugin development

The VS Code plugin lives in `ide-plugins/vscode`.

```bash
cd ide-plugins/vscode
npm install
npm run compile
```

Debug from this repo with VS Code's `Run VS Code Extension` launch config. It compiles the plugin, opens an Extension Development Host, starts a local Pi IDE Protocol server, and writes `~/.pi/ide/<port>.lock`.

Manual smoke test:

1. Launch `Run VS Code Extension`.
2. In the Extension Development Host, open a project folder.
3. Run Pi in the same project with this package loaded: `pi -e .`.
4. Use `/ide` if auto-connect did not connect.
5. Select text in VS Code; Pi footer should show the file/range.
6. Run `Pi: Mention Selection`; Pi input should receive `@file#x-y`.
7. Run `Pi: Attach Problems`; Pi input should receive `[problems: path#line-range]`.

## IDE problems

VS Code also provides `Pi: Attach Problems` and `Pi: Attach Workspace Problems`.
The file command captures diagnostics intersecting non-empty editor selections, or all
active-file diagnostics when there is no selection. It pastes
`[problems: path#line-range]` for a selection or `[problems: path]` for the whole file;
the workspace command pastes `[problems: workspace]`. Keep the marker in the submitted
prompt to attach that problems snapshot. Notebook markers and context include the cell
id/index, with cell-relative line ranges. A selection without Problems shows a notification
and sends nothing to Pi. Selection-scoped Problems include a bounded snapshot of the selected
code. If aggregate Problems context exceeds Pi's standard output limit, Pi saves the full
context across message history to a temporary file and gives the model its path. Workspace
attachment similarly notifies and sends nothing when no workspace Problems remain.

Default shortcuts are `Alt+Shift+L` for `Pi: Mention Selection` and `Alt+Shift+D` for `Pi: Attach Problems`.

## Protocol docs

- [`PI_IDE_PROTOCOL.md`](./docs/PI_IDE_PROTOCOL.md) — Canonical pi-native protocol.
- [`CC_IDE_PROTOCOL.md`](./docs/CC_IDE_PROTOCOL.md) — Historical Claude Code IDE protocol reference only.

## Local development

```bash
bun install
bun run check
pi -e .
```

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
