import { expect, mock, test } from "bun:test"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { App, PluginManifest } from "obsidian"

class FileSystemAdapter {
	constructor(private root: string) {}
	getBasePath() {
		return this.root
	}
}

mock.module("obsidian", () => ({
	Plugin: class {
		constructor(
			public app: App,
			public manifest: PluginManifest
		) {}
	},
	FileSystemAdapter,
	MarkdownView: class {},
	SuggestModal: class {},
	Notice: class {},
	apiVersion: "test"
}))
mock.module("@codemirror/view", () => ({ EditorView: {} }))
const { default: PiPlugin } = await import("../src/main.ts")

test("unload removes the lock immediately even when server shutdown stalls", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-obsidian-unload-"))
	try {
		const lockPath = join(root, "12345.lock")
		writeFileSync(lockPath, "{}")
		const plugin = new PiPlugin({} as App, {} as PluginManifest)
		let stopping = false
		Object.assign(plugin, {
			lockPath,
			server: {
				stop() {
					stopping = true
					return new Promise(() => {})
				}
			}
		})
		plugin.onunload()
		expect(existsSync(lockPath)).toBe(false)
		expect(stopping).toBe(true)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test("startup reaps closed Obsidian ports but preserves live vaults sharing a PID", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-obsidian-locks-"))
	const lockDir = join(root, "ide")
	mkdirSync(lockDir)
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR
	process.env.PI_CODING_AGENT_DIR = join(root, "agent")
	const closedServer = createServer()
	const servers = [createServer(socket => socket.end()), createServer(socket => socket.end()), closedServer]
	const plugin = new PiPlugin({ vault: { adapter: new FileSystemAdapter(root) } } as unknown as App, { version: "test" } as PluginManifest)
	Object.assign(plugin, { registerRuntimeHooks() {} })
	try {
		const ports: number[] = []
		for (const server of servers) {
			server.listen(0, "127.0.0.1")
			await once(server, "listening")
			const address = server.address()
			if (!address || typeof address === "string") throw new Error("Missing server address")
			ports.push(address.port)
		}
		servers.pop()
		await new Promise<void>(resolve => closedServer.close(() => resolve()))
		for (const [index, port] of ports.entries()) {
			writeFileSync(
				join(lockDir, `${port}.lock`),
				JSON.stringify({
					protocol: "pi-ide",
					version: 1,
					port,
					pid: process.pid,
					ide: "Obsidian",
					token: "test",
					workspaces: [join(root, `vault-${index}`)]
				})
			)
		}
		writeFileSync(join(lockDir, "foreign.lock"), '{"protocol":"other-ide"}')
		const otherProcessPath = join(lockDir, "65535.lock")
		writeFileSync(
			otherProcessPath,
			JSON.stringify({
				...JSON.parse(readFileSync(join(lockDir, `${ports[2]}.lock`), "utf8")),
				port: 65535,
				pid: process.ppid
			})
		)
		await plugin.onload()
		expect(existsSync(join(lockDir, `${ports[0]}.lock`))).toBe(true)
		expect(existsSync(join(lockDir, `${ports[1]}.lock`))).toBe(true)
		const stalePath = join(lockDir, `${ports[2]}.lock`)
		// The new listener may reuse the closed port, but must not retain its old advertisement.
		expect(existsSync(stalePath) ? JSON.parse(readFileSync(stalePath, "utf8")).token : undefined).not.toBe("test")
		expect(existsSync(join(lockDir, "foreign.lock"))).toBe(true)
		expect(existsSync(otherProcessPath)).toBe(true)
	} finally {
		plugin.onunload()
		await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir
		rmSync(root, { recursive: true, force: true })
	}
})
