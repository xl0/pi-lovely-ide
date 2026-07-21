# Pi Lovely IDE

Connect the [Pi](https://github.com/earendil-works/pi) coding agent to VS Code. Pi's footer
tracks your cursor and selection live, and two keystrokes send Pi exactly what you're
looking at — code ranges and diagnostics, with file, line, and notebook-cell locations
attached — no copy-pasting into the prompt.

Works with any Pi session started inside a workspace folder of this window. Requires the
Pi-side package [`@xl0/pi-lovely-ide`](https://www.npmjs.com/package/@xl0/pi-lovely-ide).

## Setup

1. Install this extension.
2. Install the Pi package:

   ```bash
   pi install npm:@xl0/pi-lovely-ide
   ```

3. Start Pi in a terminal inside the workspace. It connects automatically; the Pi footer
   shows `● IDE` when it does. Use Pi's `/ide` command to connect manually or tweak behavior.

## Commands

| Command | Keybinding | What it does |
| --- | --- | --- |
| `Pi: Mention Selection` | `Alt+Shift+L` | Pastes an `@file#range` reference into Pi's input. The model receives the referenced code with your next prompt. |
| `Pi: Attach Problems` | `Alt+Shift+D` | Pastes a `[problems: …]` marker for the diagnostics under your selection — or the whole active file when nothing is selected. Selection-scoped attachments include the selected code. |
| `Pi: Attach Workspace Problems` | — | Attaches all cached diagnostics for workspace files as `[problems: workspace]`. |

With more than one connected Pi session, a picker asks which session to send to. A selection
with no Problems (or an empty workspace Problems set) shows a notification and sends
nothing. Notebook selections, mentions, and Problems carry the cell id/index and
cell-relative line numbers.

The pasted references are plain text — edit or delete them freely in Pi's input. The rich
context is attached only if the reference is still present in the prompt you submit.

## How it works

The extension runs a WebSocket server on `127.0.0.1` (one per window) and advertises it in
`~/.pi/ide/<port>.lock` along with a random per-window token and the workspace folders. Pi
discovers the lockfile, connects when its working directory is inside one of the advertised
workspaces, and authenticates with the token. Editor selection changes, mention commands,
and Problems commands are then published as events to subscribed Pi sessions. Nothing
leaves your machine: both ends of the connection are local processes.

The lockfile is removed on deactivation, and stale lockfiles from dead processes are
cleaned up opportunistically.

## Troubleshooting

- Logs are in the Output panel, channel **Pi Lovely IDE**.
- If Pi doesn't connect: check that Pi runs inside a workspace folder of this window, and
  run `/ide` in Pi to see the discovered endpoints.
- Reloading the VS Code window restarts the server on a new port; Pi reconnects
  automatically when auto-reconnect is enabled in `/ide`.
