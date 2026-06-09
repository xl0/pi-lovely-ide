# lovely-ide

Pi package for the Lovely IDE integration extension.

## How it works

[![Demo](./demo.gif)](https://github.com/xl0/pi-lovely-ide/releases/download/demo/demo.mp4)

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

## Protocol docs

- [`PI_IDE_PROTOCOL.md`](./PI_IDE_PROTOCOL.md) — Canonical pi-native protocol.
- [`CC_IDE_PROTOCOL.md`](./CC_IDE_PROTOCOL.md) — Historical Claude Code IDE protocol reference only.

## Local development

```bash
bun install
bun run check
pi -e .
```
