import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"

interface IdeLockFile {
	pid?: number
	workspaceFolders?: string[]
	ideName?: string
	transport?: string
	authToken?: string
}

interface DiscoveredIde {
	port: number
	lock: IdeLockFile
	projectDir: string
}

interface JsonRpcMessage {
	jsonrpc?: string
	id?: string | number
	method?: string
	params?: unknown
	result?: unknown
	error?: unknown
}

interface IdeSelection {
	text?: string
	filePath?: string
	selection?: {
		start?: { line?: number; character?: number }
		end?: { line?: number; character?: number }
		isEmpty?: boolean
	}
}

interface AtMention {
	filePath?: string
	lineStart?: number
	lineEnd?: number
}

const IDE_LOCK_DIR = join(homedir(), ".claude", "ide")
const STATUS_KEY = "ide-integration"
const CONNECT_TIMEOUT_MS = 10_000
const RECONNECT_DELAY_MS = 1_000

interface IdeConfig {
	autoConnectOnStartup?: boolean
	autoReconnect?: boolean
}

export default function ideIntegrationExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | null = null
	let ws: WebSocket | null = null
	let connected: DiscoveredIde | null = null
	let currentSelection: IdeSelection | null = null
	let nextRequestId = 1
	let connectRun = 0
	let projectDir: string | null = null
	let autoConnectOnStartup = true
	let autoReconnect = true
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined

	function configPath(): string {
		// biome-ignore lint/style/noNonNullAssertion: projectDir is set on session_start before any access.
		return join(projectDir!, ".pi", "xl0-lovely-ide.json")
	}

	async function loadConfig(): Promise<void> {
		if (!projectDir) return
		try {
			const raw = await readFile(configPath(), "utf8")
			const cfg = JSON.parse(raw) as IdeConfig
			if (typeof cfg.autoConnectOnStartup === "boolean") autoConnectOnStartup = cfg.autoConnectOnStartup
			if (typeof cfg.autoReconnect === "boolean") autoReconnect = cfg.autoReconnect
		} catch {
			// No config yet — use defaults.
		}
	}

	async function saveConfig(): Promise<void> {
		if (!projectDir) return
		const path = configPath()
		try {
			await mkdir(join(projectDir, ".pi"), { recursive: true })
		} catch {
			return
		}
		try {
			await writeFile(path, `${JSON.stringify({ autoConnectOnStartup, autoReconnect }, null, "\t")}\n`, "utf8")
		} catch {
			// Best effort.
		}
	}

	function isPidAlive(pid: number | undefined): boolean {
		if (!pid || !Number.isInteger(pid)) return false
		try {
			process.kill(pid, 0)
			return true
		} catch {
			return false
		}
	}

	async function canonicalPath(path: string): Promise<string> {
		try {
			return await realpath(path)
		} catch {
			return path
		}
	}

	async function normalizeWorkspaceFolder(folder: string): Promise<string> {
		const path = folder.startsWith("file://") ? fileURLToPath(folder) : folder
		return canonicalPath(path)
	}

	async function discoverMatchingIdes(cwd: string): Promise<DiscoveredIde[]> {
		const projectDir = await canonicalPath(cwd)
		let files: string[]
		try {
			files = await readdir(IDE_LOCK_DIR)
		} catch {
			return []
		}

		const ides: DiscoveredIde[] = []
		for (const file of files.sort()) {
			if (!file.endsWith(".lock")) continue

			const port = Number.parseInt(file.replace(/\.lock$/, ""), 10)
			if (!Number.isFinite(port)) continue

			try {
				const lock = JSON.parse(await readFile(join(IDE_LOCK_DIR, file), "utf8")) as IdeLockFile
				if (lock.transport !== "ws") continue
				if (!lock.authToken) continue
				if (!isPidAlive(lock.pid)) continue

				const workspaceFolders = lock.workspaceFolders ?? []
				for (const folder of workspaceFolders) {
					if ((await normalizeWorkspaceFolder(folder)) === projectDir) {
						ides.push({ port, lock, projectDir })
						break
					}
				}
			} catch {
				// Stale or malformed lock file.
			}
		}

		return ides
	}

	function sendJson(socket: WebSocket, message: JsonRpcMessage): void {
		socket.send(JSON.stringify(message))
	}

	function sendNotification(method: string, params?: unknown): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		sendJson(ws, { jsonrpc: "2.0", method, params })
	}

	function initialize(socket: WebSocket): Promise<void> {
		const id = nextRequestId++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("initialize timed out")), CONNECT_TIMEOUT_MS)

			const onMessage = (event: MessageEvent) => {
				const raw = typeof event.data === "string" ? event.data : String(event.data)
				let msg: JsonRpcMessage
				try {
					msg = JSON.parse(raw) as JsonRpcMessage
				} catch {
					return
				}

				if (msg.id === id && msg.method == null) {
					clearTimeout(timer)
					socket.removeEventListener("message", onMessage)
					if (msg.error) reject(new Error(`initialize failed: ${JSON.stringify(msg.error)}`))
					else resolve()
				}
			}

			socket.addEventListener("message", onMessage)
			sendJson(socket, {
				jsonrpc: "2.0",
				id,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "pi-ide-integration", version: "0.1.0" }
				}
			})
		})
	}

	function describeSelection(): string | undefined {
		if (!currentSelection?.filePath) return undefined

		const start = currentSelection.selection?.start
		const end = currentSelection.selection?.end
		const startLine = typeof start?.line === "number" ? start.line + 1 : "?"
		const endLine = typeof end?.line === "number" ? end.line + 1 : "?"
		const path = displayPath(currentSelection.filePath)
		const lineRange = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`
		return `${path}#${lineRange}`
	}

	function displayPath(path: string): string {
		const cwd = currentCtx?.cwd
		if (!cwd) return path
		const rel = relative(cwd, path)
		return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : path
	}

	function updateStatus(): void {
		if (!currentCtx) return
		const th = currentCtx.ui.theme
		if (!connected) {
			if (!autoConnectOnStartup && !autoReconnect) {
				currentCtx.ui.setStatus(STATUS_KEY, th.fg("muted", "○ IDE disabled"))
			} else {
				currentCtx.ui.setStatus(STATUS_KEY, th.fg("error", "○ IDE disconnected"))
			}
			return
		}

		const ide = connected.lock.ideName ?? "IDE"
		const pid = connected.lock.pid ?? "?"
		const selection = describeSelection()
		currentCtx.ui.setStatus(STATUS_KEY, `${th.fg("success", "● IDE")} ${ide} ${pid}${selection ? ` ${selection}` : ""}`)
	}

	function mentionText(mention: AtMention): string | undefined {
		if (!mention.filePath) return undefined
		let ref = `@${displayPath(mention.filePath)}`
		if (typeof mention.lineStart === "number" && typeof mention.lineEnd === "number") {
			const range = mention.lineStart === mention.lineEnd ? String(mention.lineStart) : `${mention.lineStart}-${mention.lineEnd}`
			ref += `#${range}`
		}
		return ref
	}

	function insertIntoEditor(text: string): void {
		if (!currentCtx) return
		currentCtx.ui.pasteToEditor(`${text} `)
	}

	function handleMessage(socket: WebSocket, event: MessageEvent): void {
		const raw = typeof event.data === "string" ? event.data : String(event.data)
		let msg: JsonRpcMessage
		try {
			msg = JSON.parse(raw) as JsonRpcMessage
		} catch {
			return
		}

		if (msg.id != null && msg.method != null) {
			// Minimal success response for IDE-initiated MCP requests such as ping.
			sendJson(socket, { jsonrpc: "2.0", id: msg.id, result: {} })
			return
		}

		if (msg.method === "selection_changed") {
			const selection = msg.params as IdeSelection | undefined
			currentSelection = selection?.filePath && !selection.selection?.isEmpty ? selection : null
			updateStatus()
			return
		}

		if (msg.method === "at_mentioned") {
			const ref = mentionText((msg.params ?? {}) as AtMention)
			if (ref) {
				insertIntoEditor(ref)
				updateStatus()
			}
		}
	}

	function clearReconnectTimer(): void {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer)
			reconnectTimer = undefined
		}
	}

	function scheduleReconnect(): void {
		if (!autoReconnect || reconnectTimer || !currentCtx) return
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined
			if (!autoReconnect || !currentCtx || ws) return
			void reconnectMatching(currentCtx)
		}, RECONNECT_DELAY_MS)
	}

	async function connectToIde(ide: DiscoveredIde, run: number): Promise<void> {
		if (!ide.lock.authToken) return
		const socket = new WebSocket(`ws://127.0.0.1:${ide.port}`, {
			protocols: ["mcp"],
			headers: { "x-claude-code-ide-authorization": ide.lock.authToken }
		} as WebSocketInit)

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("connect timed out")), CONNECT_TIMEOUT_MS)
				socket.addEventListener(
					"open",
					() => {
						clearTimeout(timer)
						resolve()
					},
					{ once: true }
				)
				socket.addEventListener(
					"error",
					() => {
						clearTimeout(timer)
						reject(new Error("websocket error"))
					},
					{ once: true }
				)
			})

			if (run !== connectRun) {
				socket.close()
				return
			}

			await initialize(socket)
			if (run !== connectRun) {
				socket.close()
				return
			}
		} catch (err) {
			socket.close()
			throw err
		}

		clearReconnectTimer()
		ws = socket
		connected = ide
		currentSelection = null
		sendNotification("notifications/initialized")
		socket.addEventListener("message", event => handleMessage(socket, event))
		socket.addEventListener("close", () => {
			if (ws === socket) {
				ws = null
				connected = null
				currentSelection = null
				updateStatus()
				scheduleReconnect()
			}
		})
		updateStatus()
	}

	async function reconnectMatching(ctx: ExtensionContext): Promise<void> {
		const run = ++connectRun
		const ides = await discoverMatchingIdes(ctx.cwd)
		if (run !== connectRun) return
		for (const ide of ides) {
			try {
				await connectToIde(ide, run)
				return
			} catch {
				// Try the next matching IDE endpoint.
			}
		}
		updateStatus()
		scheduleReconnect()
	}

	async function connectOnStartup(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx
		disconnect(false)
		updateStatus()
		await reconnectMatching(ctx)
	}

	function disconnect(invalidateRun = true): void {
		if (invalidateRun) connectRun++
		clearReconnectTimer()
		const socket = ws
		ws = null
		connected = null
		currentSelection = null
		if (socket) socket.close()
		updateStatus()
	}

	pi.registerCommand("ide", {
		description: "Connect to an IDE, toggle auto-connect/reconnect",
		handler: async (_args, ctx) => {
			currentCtx = ctx
			const ides = await discoverMatchingIdes(ctx.cwd)

			type ToggleItem = "autoConnectOnStartup" | "autoReconnect"

			function labelForToggle(key: ToggleItem): string {
				const val = key === "autoConnectOnStartup" ? autoConnectOnStartup : autoReconnect
				const label = key === "autoConnectOnStartup" ? "Auto-connect on startup" : "Auto-reconnect on loss"
				return `${label}  ${val ? "on" : "off"}`
			}

			const toggleItems = new Set<ToggleItem>(["autoConnectOnStartup", "autoReconnect"])
			function isToggleItem(value: string): value is ToggleItem {
				return toggleItems.has(value as ToggleItem)
			}

			const items: SelectItem[] = [
				...ides.map((ide): SelectItem => {
					const name = ide.lock.ideName ?? "IDE"
					const pid = ide.lock.pid ?? "?"
					const cur = connected?.port === ide.port ? " (current)" : ""
					return { value: ide.port.toString(), label: `${name} ${pid}${cur}` }
				}),
				{ value: "Disconnect", label: "Disconnect" },
				{ value: "autoConnectOnStartup", label: labelForToggle("autoConnectOnStartup") },
				{ value: "autoReconnect", label: labelForToggle("autoReconnect") }
			]

			let initialIndex = items.length - 1
			if (connected) {
				const idx = items.findIndex(i => i.value === connected?.port.toString())
				if (idx !== -1) initialIndex = idx
			}

			const result = await ctx.ui.custom<
				{ action: "connect"; ide: DiscoveredIde } | { action: "toggle" } | { action: "disconnect" } | undefined
			>((tui, theme, _kb, done) => {
				const container = new Container()

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
				container.addChild(new Text(theme.fg("accent", theme.bold("IDE Connection")), 1, 0))

				const selectList = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t)
				})
				selectList.setSelectedIndex(initialIndex)

				selectList.onSelect = item => {
					if (item.value === "Disconnect") {
						done({ action: "disconnect" })
					} else if (isToggleItem(item.value)) {
						done({ action: "toggle" })
					} else {
						const ide = ides.find(i => i.port.toString() === item.value)
						if (ide) done({ action: "connect", ide })
					}
				}

				selectList.onCancel = () => {
					done(undefined)
				}

				container.addChild(selectList)
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • space toggle • esc cancel"), 1, 0))
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "space")) {
							const sel = selectList.getSelectedItem()
							if (sel && isToggleItem(sel.value)) {
								if (sel.value === "autoConnectOnStartup") autoConnectOnStartup = !autoConnectOnStartup
								else if (sel.value === "autoReconnect") autoReconnect = !autoReconnect
								void saveConfig()
								const idx = items.findIndex(i => i.value === sel.value)
								if (idx !== -1) items[idx] = { value: sel.value, label: labelForToggle(sel.value) }
								selectList.invalidate()
								tui.requestRender()
							}
							return
						}
						selectList.handleInput(data)
						tui.requestRender()
					}
				}
			})

			if (!result) return

			if (result.action === "disconnect") {
				disconnect()
			} else if (result.action === "toggle") {
				void saveConfig()
			} else if (result.action === "connect") {
				const run = ++connectRun
				disconnect(false)
				try {
					await connectToIde(result.ide, run)
				} catch (err) {
					updateStatus()
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
					scheduleReconnect()
				}
			}
		}
	})

	pi.on("session_start", async (_event, ctx) => {
		projectDir = ctx.cwd
		await loadConfig()
		if (autoConnectOnStartup) await connectOnStartup(ctx)
	})

	pi.on("session_shutdown", () => {
		disconnect()
		currentCtx?.ui.setStatus(STATUS_KEY, undefined)
	})
}
