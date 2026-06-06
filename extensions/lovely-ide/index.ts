import { readdir, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"
import { WebSocket } from "undici"
import { registerIdeCommand } from "./command.js"
import { ConfigState } from "./config.js"
import { displayPathForCwd, parseAtMention, parseIdeSelection, SelectionState } from "./selection.js"

const IDE_LOCK_DIR = join(homedir(), ".claude", "ide")
const STATUS_KEY = "lovely-ide"
const CONNECT_TIMEOUT_MS = 3_000
const RECONNECT_DELAY_MS = 1_000

const IdeLockFileSchema = Type.Object(
	{
		pid: Type.Optional(Type.Integer({ minimum: 1 })),
		workspaceFolders: Type.Optional(Type.Array(Type.String())),
		ideName: Type.Optional(Type.String()),
		transport: Type.Optional(Type.String()),
		runningInWindows: Type.Optional(Type.Boolean()),
		authToken: Type.Optional(Type.String())
	},
	{ additionalProperties: true }
)

type IdeLockFile = Static<typeof IdeLockFileSchema>

const IdeLockFileValidator = Compile(IdeLockFileSchema)

interface DiscoveredIde {
	port: number
	lock: IdeLockFile
	projectDir: string
}

const JsonRpcMessageSchema = Type.Object(
	{
		jsonrpc: Type.Optional(Type.String()),
		id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
		method: Type.Optional(Type.String()),
		params: Type.Optional(Type.Unknown()),
		result: Type.Optional(Type.Unknown()),
		error: Type.Optional(Type.Unknown())
	},
	{ additionalProperties: true }
)

type JsonRpcMessage = Static<typeof JsonRpcMessageSchema>

const JsonRpcMessageValidator = Compile(JsonRpcMessageSchema)

function parseJsonRpcMessage(raw: string): JsonRpcMessage | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}
	return JsonRpcMessageValidator.Check(parsed) ? parsed : undefined
}

function parseIdeLockFile(raw: string): IdeLockFile | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}
	return IdeLockFileValidator.Check(parsed) ? parsed : undefined
}

export default function lovelyIdeExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | null = null
	let ws: WebSocket | null = null
	let connected: DiscoveredIde | null = null
	let nextRequestId = 1
	let connecting = false
	let connectingSocket: WebSocket | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined

	const config = new ConfigState()
	const selection = new SelectionState(displayPath)

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
				const lock = parseIdeLockFile(await readFile(join(IDE_LOCK_DIR, file), "utf8"))
				if (!lock) continue
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
				// Stale lock file.
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

			const onMessage = (event: Event) => {
				const data = (event as MessageEvent).data
				const raw = typeof data === "string" ? data : String(data)
				const msg = parseJsonRpcMessage(raw)
				if (!msg) return

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
					clientInfo: { name: "pi-lovely-ide", version: "0.1.0" }
				}
			})
		})
	}

	function displayPath(path: string): string {
		return displayPathForCwd(currentCtx?.cwd, path)
	}

	function updateStatus(): void {
		if (!currentCtx) return
		const th = currentCtx.ui.theme
		if (!connected) {
			if (config.disabled) {
				currentCtx.ui.setStatus(STATUS_KEY, th.fg("muted", "○ IDE disabled"))
			} else {
				currentCtx.ui.setStatus(STATUS_KEY, th.fg("error", "○ IDE disconnected"))
			}
			return
		}

		const ide = connected.lock.ideName ?? "IDE"
		const pid = connected.lock.pid ?? "?"
		const selectionText = config.selectionContext ? selection.describeCurrent() : undefined
		currentCtx.ui.setStatus(STATUS_KEY, `${th.fg("success", "● IDE")} ${ide} ${pid}${selectionText ? ` ${selectionText}` : ""}`)
	}

	function insertIntoEditor(text: string): void {
		if (!currentCtx) return
		currentCtx.ui.pasteToEditor(`${text} `)
	}

	function handleMessage(socket: WebSocket, event: Event): void {
		const data = (event as MessageEvent).data
		const raw = typeof data === "string" ? data : String(data)
		const msg = parseJsonRpcMessage(raw)
		if (!msg) return

		if (msg.id != null && msg.method != null) {
			// Minimal success response for IDE-initiated MCP requests such as ping.
			sendJson(socket, { jsonrpc: "2.0", id: msg.id, result: {} })
			return
		}

		if (msg.method === "selection_changed") {
			const params = parseIdeSelection(msg.params ?? {})
			if (!params) return
			selection.setCurrent(params)
			updateStatus()
			return
		}

		if (msg.method === "at_mentioned") {
			const mention = parseAtMention(msg.params)
			if (!mention) return
			insertIntoEditor(selection.mentionText(mention))
			updateStatus()
		}
	}

	function clearReconnectTimer(): void {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer)
			reconnectTimer = undefined
		}
	}

	function scheduleReconnect(): void {
		if (!config.autoReconnect || reconnectTimer || !currentCtx) return
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined
			if (!config.autoReconnect || !currentCtx || ws || connecting) return
			void reconnectMatching(currentCtx)
		}, RECONNECT_DELAY_MS)
	}

	async function connectToIde(ide: DiscoveredIde): Promise<void> {
		if (!ide.lock.authToken || connecting) return
		connecting = true
		const socket = new WebSocket(`ws://127.0.0.1:${ide.port}`, {
			protocols: ["mcp"],
			headers: { "x-claude-code-ide-authorization": ide.lock.authToken }
		})
		connectingSocket = socket

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

			await initialize(socket)
			if (connectingSocket !== socket) {
				socket.close()
				return
			}
		} catch (err) {
			socket.close()
			throw err
		} finally {
			connecting = false
			if (connectingSocket === socket) connectingSocket = null
		}

		clearReconnectTimer()
		ws = socket
		connected = ide
		selection.clearCurrent()
		sendNotification("notifications/initialized")
		socket.addEventListener("message", event => handleMessage(socket, event))
		socket.addEventListener("close", () => {
			if (ws === socket) {
				ws = null
				connected = null
				selection.clearCurrent()
				updateStatus()
				scheduleReconnect()
			}
		})
		updateStatus()
	}

	async function reconnectMatching(ctx: ExtensionContext): Promise<void> {
		if (ws || connecting) return
		const ides = await discoverMatchingIdes(ctx.cwd)
		for (const ide of ides) {
			try {
				await connectToIde(ide)
				return
			} catch {
				// Try next matching IDE endpoint.
			}
		}
		updateStatus()
		scheduleReconnect()
	}

	async function connectOnStartup(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx
		disconnect()
		updateStatus()
		await reconnectMatching(ctx)
	}

	async function connectFromCommand(ide: DiscoveredIde): Promise<void> {
		if (connecting) throw new Error("IDE connection already in progress")
		disconnect()
		await connectToIde(ide)
	}

	function disconnect(): void {
		clearReconnectTimer()
		const socket = ws
		const pendingSocket = connectingSocket
		ws = null
		connected = null
		selection.clearCurrent()
		if (socket) socket.close()
		if (pendingSocket) pendingSocket.close()
		connecting = false
		connectingSocket = null
		updateStatus()
	}

	registerIdeCommand(pi, {
		config,
		selection,
		discoverMatchingIdes,
		connected: () => connected,
		connect: connectFromCommand,
		disconnect,
		updateStatus,
		scheduleReconnect
	})

	pi.on("input", (event, ctx) => {
		const streamingBehavior = (event as { streamingBehavior?: "steer" | "followUp" }).streamingBehavior
		const canUseSelection =
			config.selectionContext &&
			(event.source === "interactive" || event.source === "rpc") &&
			streamingBehavior === undefined &&
			ctx.isIdle()
		selection.capturePending(canUseSelection)
		return { action: "continue" }
	})

	pi.on("before_agent_start", () => {
		selection.startTurn(config.selectionContext)
	})

	pi.on("message_start", event => {
		selection.handleMessageStart(event.message)
	})

	pi.on("context", event => {
		const messages = selection.injectContext(event.messages, config.selectionContext)
		if (messages) return { messages }
	})

	pi.on("agent_end", () => {
		selection.clearTurn()
	})

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx
		config.setProjectDir(ctx.cwd)
		await config.load()
		updateStatus()
		if (config.autoConnectOnStartup) await connectOnStartup(ctx)
	})

	pi.on("session_shutdown", () => {
		selection.clearTurn()
		disconnect()
		currentCtx?.ui.setStatus(STATUS_KEY, undefined)
	})
}
