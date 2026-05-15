# ide-integration

Pi package template for an IDE integration extension.

https://github.com/user-attachments/assets/demo.mp4

<video src="./demo.mp4" controls muted></video>

## Install

```bash
pi install npm:@xl0/pi-ide-integration
```

Or load without installing:

```bash
pi -e npm:@xl0/pi-ide-integration
```

## Local development

```bash
bun install
bun run check
pi -e .
```

## Structure

- `package.json` — npm and Pi package manifest
- `extensions/ide-integration/index.ts` — extension entry point
