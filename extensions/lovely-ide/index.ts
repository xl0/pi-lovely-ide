import { readdir, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"
import { registerIdeCommand } from "./command.js"
import { ConfigState } from "./config.js"
import { IdeConnection, type JsonRpcMessage } from "./connection.js"
import { formatAtMention, parseAtMention } from "./mention.js"
import {
	displayPathForCwd,
	injectSelectionContext,
	parseIdeSelection,
	SELECTION_CONTEXT_CUSTOM_TYPE,
	type SelectionSnapshot,
	SelectionState
} from "./selection.js"

const IDE_LOCK_DIR = join(homedir(), ".claude", "ide")
const STATUS_KEY = "lovely-ide"
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
	let connection: IdeConnection | null = null
	let connected: DiscoveredIde | null = null
	let nextRequestId = 1
	let connecting = false
	let connectingConnection: IdeConnection | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	let pendingSelection: SelectionSnapshot | null | undefined

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

	function handleMessage(message: JsonRpcMessage, activeConnection: IdeConnection): void {
		if (message.id != null && message.method != null) {
			// Minimal success response for IDE-initiated MCP requests such as ping.
			activeConnection.send({ jsonrpc: "2.0", id: message.id, result: {} })
			return
		}

		if (message.method === "selection_changed") {
			const params = parseIdeSelection(message.params ?? {})
			if (!params) return
			selection.setCurrent(params)
			updateStatus()
			return
		}

		if (message.method === "at_mentioned") {
			const mention = parseAtMention(message.params)
			if (!mention || !currentCtx) return
			currentCtx.ui.pasteToEditor(`${formatAtMention(mention, displayPath)} `)
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
			if (!config.autoReconnect || !currentCtx || connection || connecting) return
			void reconnectMatching(currentCtx)
		}, RECONNECT_DELAY_MS)
	}

	async function connectToIde(ide: DiscoveredIde): Promise<void> {
		if (!ide.lock.authToken || connecting) return
		connecting = true
		const newConnection = new IdeConnection({
			port: ide.port,
			authToken: ide.lock.authToken,
			requestId: nextRequestId++,
			onMessage: handleMessage,
			onClose(closedConnection) {
				if (connection === closedConnection) {
					connection = null
					connected = null
					selection.clearCurrent()
					updateStatus()
					scheduleReconnect()
				}
			}
		})
		connectingConnection = newConnection

		try {
			await newConnection.connect()
			if (connectingConnection !== newConnection) {
				newConnection.close()
				return
			}

			clearReconnectTimer()
			connection = newConnection
			connected = ide
			selection.clearCurrent()
			updateStatus()
		} finally {
			connecting = false
			if (connectingConnection === newConnection) connectingConnection = null
		}
	}

	async function reconnectMatching(ctx: ExtensionContext): Promise<void> {
		if (connection || connecting) return
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
		const activeConnection = connection
		const pendingConnection = connectingConnection
		connection = null
		connected = null
		selection.clearCurrent()
		if (activeConnection) activeConnection.close()
		if (pendingConnection) pendingConnection.close()
		connecting = false
		connectingConnection = null
		updateStatus()
	}

	registerIdeCommand(pi, {
		config,
		discoverMatchingIdes,
		connected: () => connected,
		connect: connectFromCommand,
		disconnect,
		updateStatus,
		scheduleReconnect
	})

	pi.on("input", (event, ctx) => {
		const streamingBehavior = (event as { streamingBehavior?: "steer" | "followUp" }).streamingBehavior
		if (
			config.selectionContext &&
			(event.source === "interactive" || event.source === "rpc") &&
			streamingBehavior === undefined &&
			ctx.isIdle()
		) {
			pendingSelection = selection.snapshotCurrent()
		} else {
			pendingSelection = undefined
		}
		return { action: "continue" }
	})

	pi.on("before_agent_start", () => {
		const snapshot = config.selectionContext ? (pendingSelection ?? null) : null
		pendingSelection = undefined
		if (snapshot) {
			return {
				message: {
					customType: SELECTION_CONTEXT_CUSTOM_TYPE,
					content: "",
					display: false,
					details: snapshot
				}
			}
		}
	})

	pi.on("context", event => {
		const messages = injectSelectionContext(event.messages, config.selectionContext, displayPath)
		if (messages) return { messages }
	})

	pi.on("agent_end", () => {
		pendingSelection = undefined
	})

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx
		config.setProjectDir(ctx.cwd)
		await config.load()
		updateStatus()
		if (config.autoConnectOnStartup) await connectOnStartup(ctx)
	})

	pi.on("session_shutdown", () => {
		pendingSelection = undefined
		disconnect()
		currentCtx?.ui.setStatus(STATUS_KEY, undefined)
	})
}
