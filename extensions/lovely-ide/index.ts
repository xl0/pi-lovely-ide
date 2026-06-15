import { randomUUID } from "node:crypto"
import { readdir, readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { type ContextEvent, type ExtensionAPI, type ExtensionContext, getAgentDir, highlightCode } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import * as v from "valibot"
import {
	type HelloParams,
	type IdeLockFile,
	type JsonRpcMessage,
	PI_IDE_PROTOCOL_VERSION,
	parseIdeJsonRpcMessage,
	parseIdeLockFile
} from "../../packages/protocol/src/index.js"
import { registerIdeCommand } from "./command.js"
import { ConfigState } from "./config.js"
import { IdeConnection } from "./connection.js"
import {
	formatIdeContextDetails,
	IDE_CONTEXT_CUSTOM_TYPE,
	type IdeContextDetails,
	injectIdeContexts,
	validateIdeContextDetails
} from "./context.js"
import { formatAtMention, type MentionSnapshot, mentionSnapshotFromEvent, mentionsReferencedInPrompt } from "./mention.js"
import { displayPathForCwd, type SelectionSnapshot, SelectionState } from "./selection.js"

const require = createRequire(import.meta.url)
const packageJson = require("../../package.json") as { version?: string }
const PACKAGE_VERSION = packageJson.version ?? "0.0.0"

const IDE_LOCK_DIR = join(dirname(getAgentDir()), "ide")
const STATUS_KEY = "lovely-ide"
const DEBUG_NOTIFICATION_CUSTOM_TYPE = "lovely-ide.debugNotification"
const SELECTION_PROMPT_GUIDELINE = "The <selection>/<cursor> blocks refer to the user's selection in the IDE. They may or may not be relevant to your task. Silently ignore them when unrelated."
const RECONNECT_DELAY_MS = 1_000
const DEBUG_NOTIFICATION_MAX_CHARS = 4_000

interface DiscoveredIde {
	port: number
	lock: IdeLockFile
}

const DebugNotificationDetailsSchema = v.looseObject({
	method: v.string(),
	pretty: v.string(),
	originalLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
	truncated: v.boolean()
})
type DebugNotificationDetails = v.InferOutput<typeof DebugNotificationDetailsSchema>

export default function lovelyIdeExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | null = null
	let connection: IdeConnection | null = null
	let connected: DiscoveredIde | null = null
	let nextRequestId = 1
	let connecting = false
	let connectingConnection: IdeConnection | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	let pendingSelection: SelectionSnapshot | null | undefined
	let pendingMentions: MentionSnapshot[] = []
	let pendingPromptMentions: MentionSnapshot[] = []
	let selectionPreviewRefresh: (() => void) | null = null
	const debugNotificationViews = new Set<Text>()

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

	function isEqualOrDescendant(path: string, root: string): boolean {
		const rel = relative(root, path)
		return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"))
	}

	function helloParams(ctx: ExtensionContext): HelloParams {
		const sessionName = ctx.sessionManager.getSessionName()
		return {
			version: PI_IDE_PROTOCOL_VERSION,
			client: {
				name: "pi-lovely-ide",
				version: PACKAGE_VERSION,
				pid: process.pid,
				mode: ctx.mode
			},
			session: {
				id: ctx.sessionManager.getSessionId(),
				...(sessionName ? { name: sessionName } : {})
			},
			connection: {
				id: randomUUID(),
				subscriptions: ["selection", "mention"]
			},
			workspace: ctx.cwd
		}
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
				if (lock.port !== port) continue
				if (lock.pid && !isPidAlive(lock.pid)) continue

				for (const folder of lock.workspaces) {
					if (isEqualOrDescendant(projectDir, await normalizeWorkspaceFolder(folder))) {
						ides.push({ port, lock })
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

	function stripDebugNotificationMessages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
		const filtered = messages.filter(message => !(message.role === "custom" && message.customType === DEBUG_NOTIFICATION_CUSTOM_TYPE))
		return filtered.length === messages.length ? messages : filtered
	}

	function validateDebugNotificationDetails(value: unknown): DebugNotificationDetails | undefined {
		const result = v.safeParse(DebugNotificationDetailsSchema, value)
		return result.success ? result.output : undefined
	}

	function clearDebugNotificationMessages(): void {
		for (const view of debugNotificationViews) view.setText("")
	}

	pi.registerMessageRenderer<DebugNotificationDetails>(DEBUG_NOTIFICATION_CUSTOM_TYPE, message => {
		const details = validateDebugNotificationDetails(message.details)
		if (!details || !config.debugNotifications) return new Text("", 0, 0)
		const suffix = details.truncated ? `\n… (${details.originalLength} chars)` : ""
		const view = new Text(`IDE raw ${details.method}:\n${highlightCode(details.pretty, "json").join("\n")}${suffix}`, 1, 0)
		debugNotificationViews.add(view)
		return view
	})

	pi.registerMessageRenderer<IdeContextDetails>(IDE_CONTEXT_CUSTOM_TYPE, message => {
		const details = validateIdeContextDetails(message.details)
		if (!details) return undefined
		const text = formatIdeContextDetails(details, displayPath, config.selectedTextLineLimit)
		return text ? new Text(text, 1, 0) : undefined
	})

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

		const ide = connected.lock.ide ?? "IDE"
		const pid = connected.lock.pid ?? "?"
		const selectionText = selection.describeCurrent()
		currentCtx.ui.setStatus(STATUS_KEY, `${th.fg("success", "● IDE")} ${ide} ${pid}${selectionText ? ` ${selectionText}` : ""}`)
	}

	function debugNotifyRawIdeNotification(message: JsonRpcMessage): void {
		if (!config.debugNotifications) return
		if (message.id != null || message.method == null) return
		const pretty = JSON.stringify(message, null, 2)
		pi.sendMessage<DebugNotificationDetails>(
			{
				customType: DEBUG_NOTIFICATION_CUSTOM_TYPE,
				content: "",
				display: true,
				details: {
					method: message.method,
					pretty: pretty.slice(0, DEBUG_NOTIFICATION_MAX_CHARS),
					originalLength: pretty.length,
					truncated: pretty.length > DEBUG_NOTIFICATION_MAX_CHARS
				}
			},
			{ triggerTurn: false }
		)
	}

	function handleMessage(message: JsonRpcMessage, _raw: string, activeConnection: IdeConnection): void {
		debugNotifyRawIdeNotification(message)
		if (message.id != null && message.method != null) {
			activeConnection.send({ jsonrpc: "2.0", id: message.id, result: {} })
			return
		}

		const parsed = parseIdeJsonRpcMessage(message)
		if (parsed.kind !== "event") return

		if (parsed.type === "selection") {
			selection.setCurrent(parsed.params)
			updateStatus()
			selectionPreviewRefresh?.()
			return
		}

		if (parsed.type === "mention") {
			if (!currentCtx) return
			const mentionSnapshot = mentionSnapshotFromEvent(parsed.params, displayPath)
			const mention = mentionSnapshot?.ref ?? formatAtMention(parsed.params, displayPath)
			if (!mention) return
			if (mentionSnapshot) pendingMentions.push(mentionSnapshot)
			currentCtx.ui.pasteToEditor(`${mention} `)
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
		if (connecting || !currentCtx) return
		connecting = true
		const newConnection = new IdeConnection({
			port: ide.port,
			token: ide.lock.token,
			requestId: nextRequestId++,
			hello: helloParams(currentCtx),
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
		scheduleReconnect,
		selectionSnapshot: () => selection.snapshotCurrent(),
		setSelectionPreviewRefresh: refresh => {
			selectionPreviewRefresh = refresh
		},
		clearDebugNotificationMessages
	})

	pi.on("input", (event, ctx) => {
		const streamingBehavior = (event as { streamingBehavior?: "steer" | "followUp" }).streamingBehavior
		const isUserInput = event.source === "interactive" || event.source === "rpc"
		// Pi emits before_agent_start in the same idle prompt() call; streamed steer/followUp gets no rich context.
		const capturePromptContext = isUserInput && streamingBehavior === undefined && ctx.isIdle()
		if (isUserInput) {
			pendingPromptMentions = capturePromptContext ? mentionsReferencedInPrompt(pendingMentions, event.text) : []
			pendingMentions = []
		}
		if (config.selectionContext && capturePromptContext) {
			pendingSelection = selection.snapshotCurrent()
		} else {
			pendingSelection = undefined
		}
		return { action: "continue" }
	})

	pi.on("before_agent_start", event => {
		const mentions = pendingPromptMentions
		const snapshot = config.selectionContext ? (pendingSelection ?? null) : null
		pendingPromptMentions = []
		pendingSelection = undefined
		const result: { message?: { customType: string; content: string; display: boolean; details: IdeContextDetails }; systemPrompt?: string } = {}
		if (mentions.length || snapshot) {
			result.message = {
				customType: IDE_CONTEXT_CUSTOM_TYPE,
				content: "",
				display: config.displaySelectionMessages,
				details: { mentions, selection: snapshot }
			}
		}
		if (snapshot && mentions.length === 0) result.systemPrompt = `${event.systemPrompt}\n\n${SELECTION_PROMPT_GUIDELINE}`
		if (result.message || result.systemPrompt !== undefined) return result
	})

	pi.on("context", event => {
		const displayMessages = stripDebugNotificationMessages(event.messages)
		const contextMessages = injectIdeContexts(displayMessages, config.selectionContext, displayPath, config.selectedTextLineLimit)
		if (contextMessages) return { messages: contextMessages }
		if (displayMessages !== event.messages) return { messages: displayMessages }
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
		pendingMentions = []
		pendingPromptMentions = []
		debugNotificationViews.clear()
		disconnect()
		currentCtx?.ui.setStatus(STATUS_KEY, undefined)
	})
}
