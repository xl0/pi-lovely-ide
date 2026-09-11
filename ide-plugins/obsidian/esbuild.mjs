import { rmSync } from "node:fs"
import * as esbuild from "esbuild"

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

rmSync("main.js", { force: true })

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2022",
	outfile: "main.js",
	external: ["obsidian", "@codemirror/view"],
	minify: production,
	sourcemap: !production ? "inline" : false,
	sourcesContent: false,
	logLevel: "warning"
})

if (watch) {
	await context.watch()
} else {
	await context.rebuild()
	await context.dispose()
}
