import { rmSync } from "node:fs"
import * as esbuild from "esbuild"

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

rmSync("dist", { recursive: true, force: true })

const context = await esbuild.context({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	outfile: "dist/extension.js",
	external: ["vscode"],
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: "warning"
})

if (watch) {
	await context.watch()
} else {
	await context.rebuild()
	await context.dispose()
}
