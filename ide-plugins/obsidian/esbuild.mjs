import { readFileSync, rmSync } from "node:fs"
import * as esbuild from "esbuild"

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

rmSync("main.js", { force: true })
// Obsidian installs only the release assets, so license notices travel inside the bundle.
const licenses = ["../../LICENSE", "node_modules/ws/LICENSE", "node_modules/valibot/LICENSE.md"]
	.map(path => readFileSync(path, "utf8"))
	.join("\n\n")

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
	banner: { js: `/*!\n${licenses.replaceAll("*/", "* /")}\n*/` },
	logLevel: "warning"
})

if (watch) {
	await context.watch()
} else {
	await context.rebuild()
	await context.dispose()
}
