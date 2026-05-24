import { readdir, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

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

export default function ideIntegrationExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | null = null
	let ws: WebSocket | null = null
	let connected: DiscoveredIde | null = null
	let currentSelection: IdeSelection | null = null
	let nextRequestId = 1
	let connectRun = 0
	let autoReconnect = true
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined

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
			currentCtx.ui.setStatus(STATUS_KEY, th.fg("error", "○ IDE disconnected"))
			return
		}

		const ide = connected.lock.ideName ?? "IDE"
		const pid = connected.lock.pid ?? "?"
		const selection = describeSelection()
		currentCtx.ui.setStatus(STATUS_KEY, `${th.fg("success", "● IDE")} ${ide} ${pid}${selection ? ` ${selection}` : ""}`)
	}

	function describeIde(ide: DiscoveredIde, index: number): string {
		const name = ide.lock.ideName ?? "IDE"
		const pid = ide.lock.pid ?? "?"
		const current = connected?.port === ide.port ? " current" : ""
		return `${index + 1}. ${name} ${pid} port:${ide.port}${current}`
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
		description: "Reconnect to a Claude Code IDE endpoint for this project",
		handler: async (_args, ctx) => {
			currentCtx = ctx
			const ides = await discoverMatchingIdes(ctx.cwd)
			const noneLabel = "None (disconnect)"
			const labels = [noneLabel, ...ides.map(describeIde)]
			const choice = await ctx.ui.select("Connect IDE", labels)
			if (!choice) return

			if (choice === noneLabel) {
				autoReconnect = false
				disconnect()
				return
			}

			const index = labels.indexOf(choice) - 1
			const ide = ides[index]
			if (!ide) return

			autoReconnect = true
			const run = ++connectRun
			disconnect(false)
			try {
				await connectToIde(ide, run)
			} catch (err) {
				updateStatus()
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
				scheduleReconnect()
			}
		}
	})

	pi.on("session_start", async (_event, ctx) => {
		await connectOnStartup(ctx)
	})

	pi.on("session_shutdown", () => {
		disconnect()
		currentCtx?.ui.setStatus(STATUS_KEY, undefined)
	})
}
