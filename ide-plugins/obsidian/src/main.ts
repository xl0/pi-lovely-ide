import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { EditorView, type ViewUpdate } from "@codemirror/view"
import { type App, apiVersion, type Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, SuggestModal } from "obsidian"
import { type WebSocket, WebSocketServer } from "ws"
import {
	type HelloParams,
	type IdeEventParams,
	type IdeLocationEventParams,
	type IdeSpan,
	type JsonRpcMessage,
	PI_IDE_AUTH_HEADER,
	PI_IDE_PROTOCOL,
	PI_IDE_PROTOCOL_VERSION,
	parseIdeLockFile,
	parseIdeMessage
} from "../../../packages/protocol/src/index.js"
import { inclusiveRangeForBounds, orderedBounds, textEndForBounds } from "./ranges.js"

interface PiConnection {
	socket: WebSocket
	hello: HelloParams
}

const MAX_SPAN_TEXT_EDGE_CHARS = 2 * 1024
const MAX_SPAN_TEXT_EDGE_LINES = 20
const CLEAR_SELECTION: IdeLocationEventParams = { type: "selection", file: null, spans: [] }

function log(message: string): void {
	console.log(`[Pi Lovely IDE] ${message}`)
}

function expandTilde(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ? resolve(expandTilde(process.env.PI_CODING_AGENT_DIR)) : join(homedir(), ".pi", "agent")
}

function lockDir(): string {
	return join(dirname(piAgentDir()), "ide")
}

function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function cleanupStaleLocks(): Promise<void> {
	let files: string[]
	try {
		files = await readdir(lockDir())
	} catch {
		return
	}
	await Promise.all(
		files.map(async file => {
			if (!file.endsWith(".lock")) return
			const path = join(lockDir(), file)
			try {
				const lock = parseIdeLockFile(await readFile(path, "utf8"))
				if (lock?.pid && !isPidAlive(lock.pid)) await rm(path, { force: true })
			} catch {
				// Non-pi or unreadable lock; leave it.
			}
		})
	)
}

async function writeLockFile(port: number, token: string, vaultRoot: string): Promise<string> {
	await mkdir(lockDir(), { recursive: true })
	const path = join(lockDir(), `${port}.lock`)
	const tmpPath = `${path}.tmp`
	try {
		await writeFile(
			tmpPath,
			JSON.stringify(
				{
					protocol: PI_IDE_PROTOCOL,
					version: PI_IDE_PROTOCOL_VERSION,
					port,
					pid: process.pid,
					workspaces: [vaultRoot],
					ide: "Obsidian",
					token
				},
				null,
				"\t"
			),
			{ mode: 0o600 }
		)
		await rename(tmpPath, path)
		return path
	} catch (error) {
		await rm(tmpPath, { force: true })
		throw error
	}
}

function send(socket: WebSocket, message: JsonRpcMessage): void {
	if (socket.readyState === 1) socket.send(JSON.stringify(message))
}

function label(conn: PiConnection): string {
	const session = conn.hello.session
	const client = conn.hello.client
	return `${session.name ?? session.id} (${client.name} pid ${client.pid}${client.mode ? ` ${client.mode}` : ""})`
}

function eventSummary(event: IdeEventParams): string {
	if (event.type === "diagnostics") return `diagnostics scope=${event.scope}`
	return `${event.type} file=${event.file ?? "<none>"} spans=${event.spans.length}`
}

class PiIdeServer {
	private server: WebSocketServer | undefined
	private connections = new Map<WebSocket, PiConnection>()
	private lastSelectionKeys = new Map<WebSocket, string>()

	constructor(
		private readonly token: string,
		private readonly pluginVersion: string,
		private readonly onHello: () => void
	) {}

	async start(): Promise<number> {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
		this.server = server
		server.on("connection", (socket, request) => {
			socket.on("error", error => log(`WebSocket error: ${error.message}`))
			if (request.headers[PI_IDE_AUTH_HEADER.toLowerCase()] !== this.token) {
				log("Rejected WebSocket connection: bad auth")
				socket.close(1008, "bad auth")
				return
			}
			log("Accepted WebSocket connection")
			socket.on("message", data => this.handleMessage(socket, data.toString()))
			socket.on("close", () => {
				const conn = this.connections.get(socket)
				log(`Closed WebSocket connection${conn ? ` from ${label(conn)}` : ""}`)
				this.connections.delete(socket)
				this.lastSelectionKeys.delete(socket)
			})
		})

		await new Promise<void>((resolvePromise, reject) => {
			const cleanup = () => {
				server.off("listening", onListening)
				server.off("error", onError)
				server.off("close", onClose)
			}
			const onListening = () => {
				cleanup()
				resolvePromise()
			}
			const onError = (error: Error) => {
				cleanup()
				reject(error)
			}
			const onClose = () => {
				cleanup()
				reject(new Error("Pi IDE server stopped before listening"))
			}
			server.once("listening", onListening)
			server.once("error", onError)
			server.once("close", onClose)
		})
		if (this.server !== server) throw new Error("Pi IDE server stopped before listening")
		const address = server.address()
		if (typeof address !== "object" || !address) throw new Error("Pi IDE server failed to bind")
		return address.port
	}

	async stop(): Promise<void> {
		const server = this.server
		this.server = undefined
		if (!server) return
		for (const socket of server.clients) socket.terminate()
		this.connections.clear()
		this.lastSelectionKeys.clear()
		await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
	}

	connectionsWith(subscription: "selection" | "mention" | "diagnostics"): PiConnection[] {
		return [...this.connections.values()].filter(conn => conn.hello.connection.subscriptions?.includes(subscription))
	}

	resetSelectionDedupe(): void {
		this.lastSelectionKeys.clear()
	}

	publishSelection(event: IdeLocationEventParams): void {
		const key = JSON.stringify(event)
		for (const conn of this.connectionsWith("selection")) {
			if (this.lastSelectionKeys.get(conn.socket) === key) continue
			this.lastSelectionKeys.set(conn.socket, key)
			log(`Send ${eventSummary(event)} to ${label(conn)}`)
			send(conn.socket, { jsonrpc: "2.0", method: "event", params: event })
		}
	}

	sendMention(conn: PiConnection, event: IdeLocationEventParams): void {
		log(`Send ${eventSummary(event)} to ${label(conn)}`)
		send(conn.socket, { jsonrpc: "2.0", method: "event", params: event })
	}

	private handleMessage(socket: WebSocket, raw: string): void {
		const parsed = parseIdeMessage(raw)
		if (!parsed) {
			log(`Ignored invalid JSON-RPC message (${raw.length} chars)`)
			return
		}
		const msg = parsed.message
		switch (parsed.kind) {
			case "hello": {
				const conn: PiConnection = { socket, hello: parsed.params }
				this.connections.set(socket, conn)
				log(`Accepted hello from ${label(conn)} workspace=${parsed.params.workspace}`)
				send(socket, {
					jsonrpc: "2.0",
					id: parsed.id,
					result: { version: PI_IDE_PROTOCOL_VERSION, ide: { name: "Obsidian", version: apiVersion || this.pluginVersion } }
				})
				this.onHello()
				return
			}
			case "ping":
				send(socket, { jsonrpc: "2.0", id: parsed.id, result: {} })
				return
			case "session_info_changed": {
				const conn = this.connections.get(socket)
				if (!conn) return
				if (parsed.params.name) conn.hello.session.name = parsed.params.name
				else delete conn.hello.session.name
				log(`Updated session info for ${label(conn)}`)
				return
			}
			case "jsonrpc":
				if (msg.method === "hello" && msg.id != null) {
					send(socket, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid hello" } })
				} else if (msg.method != null && msg.id != null) {
					send(socket, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
				}
				return
			case "event":
				return
		}
	}
}

function excerptForText(text: string, totalLines: number): NonNullable<IdeSpan["text"]> {
	const totalCharacters = text.length
	if (totalLines <= MAX_SPAN_TEXT_EDGE_LINES * 2 && totalCharacters <= MAX_SPAN_TEXT_EDGE_CHARS * 2) {
		return { head: text, totalCharacters, totalLines }
	}
	const lines = text.split(/\r?\n/)
	const headText = lines.slice(0, MAX_SPAN_TEXT_EDGE_LINES).join("\n")
	const tailText = lines.slice(-MAX_SPAN_TEXT_EDGE_LINES).join("\n")
	return {
		head: headText.slice(0, MAX_SPAN_TEXT_EDGE_CHARS),
		tail: tailText.slice(-MAX_SPAN_TEXT_EDGE_CHARS),
		totalCharacters,
		totalLines,
		...(headText.length > MAX_SPAN_TEXT_EDGE_CHARS ? { headTruncated: true } : {}),
		...(tailText.length > MAX_SPAN_TEXT_EDGE_CHARS ? { tailTruncated: true } : {})
	}
}

function lineText(editor: Editor, line: number): string {
	return line >= 0 && line < editor.lineCount() ? editor.getLine(line) : ""
}

function spanForSelection(
	editor: Editor,
	selection: { anchor: { line: number; ch: number }; head: { line: number; ch: number } }
): IdeSpan {
	const { from, to } = orderedBounds(selection.anchor, selection.head)
	const range = inclusiveRangeForBounds(line => lineText(editor, line), from, to)
	const textEnd = textEndForBounds(line => lineText(editor, line), from, to)
	const selectedText = editor.getRange(from, textEnd)
	return {
		range,
		...(selectedText ? { text: excerptForText(selectedText, range.end.line - range.start.line + 1) } : {})
	}
}

function spansForEditor(editor: Editor): IdeSpan[] {
	const selections = editor.listSelections()
	if (selections.length === 0) {
		const cursor = editor.getCursor()
		return [{ range: { start: { line: cursor.line, character: cursor.ch }, end: { line: cursor.line, character: cursor.ch } } }]
	}
	return selections.map(selection => spanForSelection(editor, selection))
}

function vaultRoot(app: App): string {
	const adapter = app.vault.adapter
	if (!(adapter instanceof FileSystemAdapter)) throw new Error("Pi Lovely IDE requires Obsidian desktop FileSystemAdapter")
	return adapter.getBasePath()
}

function readingViewExcerpt(view: MarkdownView): IdeLocationEventParams["text"] {
	const container = view.previewMode.containerEl
	const selection = container.ownerDocument.getSelection()
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
	const range = selection.getRangeAt(0)
	// Ignore selections in sidebars, popovers, or another note.
	if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return undefined
	const text = selection.toString()
	return text ? excerptForText(text, text.split(/\r?\n/).length) : undefined
}

function selectionEvent(app: App, root: string): IdeLocationEventParams {
	const view = app.workspace.getActiveViewOfType(MarkdownView)
	if (!view?.file) return CLEAR_SELECTION
	const file = resolve(root, view.file.path)
	if (view.getMode() === "preview") {
		const text = readingViewExcerpt(view)
		return { type: "selection", file, spans: [], ...(text ? { text } : {}) }
	}
	return { type: "selection", file, spans: spansForEditor(view.editor) }
}

function mentionEvent(app: App, root: string, wholeNote: boolean): IdeLocationEventParams | undefined {
	const event = selectionEvent(app, root)
	if (!event.file) return undefined
	return wholeNote ? { type: "mention", file: event.file, spans: [] } : { ...event, type: "mention" }
}

class ConnectionSuggestModal extends SuggestModal<PiConnection> {
	private chosen = false

	constructor(
		app: App,
		private readonly targets: PiConnection[],
		private readonly resolveChoice: (conn: PiConnection | undefined) => void
	) {
		super(app)
		this.setPlaceholder("Send mention to Pi")
	}

	getSuggestions(query: string): PiConnection[] {
		const q = query.toLowerCase()
		return this.targets.filter(conn => label(conn).toLowerCase().includes(q))
	}

	renderSuggestion(conn: PiConnection, el: HTMLElement): void {
		el.createDiv({ text: label(conn) })
		el.createEl("small", { text: `workspace: ${conn.hello.workspace}` })
	}

	onChooseSuggestion(conn: PiConnection): void {
		this.chosen = true
		this.resolveChoice(conn)
	}

	onClose(): void {
		super.onClose()
		queueMicrotask(() => {
			if (!this.chosen) this.resolveChoice(undefined)
		})
	}
}

async function pickMentionTarget(app: App, server: PiIdeServer): Promise<PiConnection | undefined> {
	const targets = server.connectionsWith("mention")
	const first = targets[0]
	if (!first) {
		new Notice("No Pi agent subscribed to mentions.")
		return undefined
	}
	if (targets.length === 1) return first
	return new Promise<PiConnection | undefined>(resolveChoice => new ConnectionSuggestModal(app, targets, resolveChoice).open())
}

export default class PiLovelyIdeObsidianPlugin extends Plugin {
	private server: PiIdeServer | undefined
	private port: number | undefined
	private lockPath: string | undefined
	private root: string | undefined
	private unloaded = false
	private publishTimer: ReturnType<Window["setTimeout"]> | undefined
	private publishTimerWindow: Window | undefined

	async onload(): Promise<void> {
		this.unloaded = false
		try {
			this.root = vaultRoot(this.app)
			const token = randomBytes(32).toString("hex")
			await cleanupStaleLocks()
			const server = new PiIdeServer(token, this.manifest.version, () => this.publishSelection())
			this.server = server
			this.port = await server.start()
			if (this.unloaded) return await this.cleanup()
			this.lockPath = await writeLockFile(this.port, token, this.root)
			if (this.unloaded) return await this.cleanup()
			this.registerRuntimeHooks()
			log(`v${this.manifest.version} listening on 127.0.0.1:${this.port}`)
		} catch (error) {
			await this.cleanup()
			if (this.unloaded) return
			throw error
		}
	}

	onunload(): void {
		this.unloaded = true
		void this.cleanup()
	}

	private registerRuntimeHooks(): void {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				if (this.isActiveWindowFocused()) this.schedulePublish()
			})
		)
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				if (this.isActiveWindowFocused()) this.schedulePublish()
			})
		)
		this.registerDomEvent(activeWindow, "focus", () => {
			this.server?.resetSelectionDedupe()
			this.publishSelection()
		})
		this.registerEditorExtension(
			EditorView.updateListener.of((update: ViewUpdate) => {
				if ((update.selectionSet || update.docChanged) && update.view.hasFocus && this.isActiveWindowFocused()) this.schedulePublish()
			})
		)
		const publishReadingSelection = () => {
			if (this.app.workspace.getActiveViewOfType(MarkdownView)?.getMode() === "preview") this.publishSelection()
		}
		this.registerDomEvent(activeWindow.document, "selectionchange", publishReadingSelection)
		// Reading panes do not reliably deliver selection events; polling also covers pop-out windows.
		this.registerInterval(window.setInterval(publishReadingSelection, 300))
		this.addCommand({
			id: "mention-selection",
			name: "Pi: Mention Selection",
			callback: () => void this.mentionSelection(false)
		})
		this.addCommand({
			id: "mention-whole-note",
			name: "Pi: Mention Whole Note",
			callback: () => void this.mentionSelection(true)
		})
	}

	private isActiveWindowFocused(): boolean {
		return activeWindow.document.hasFocus()
	}

	private schedulePublish(): void {
		if (this.publishTimer !== undefined) this.publishTimerWindow?.clearTimeout(this.publishTimer)
		const timerWindow = activeWindow
		this.publishTimerWindow = timerWindow
		this.publishTimer = timerWindow.setTimeout(() => {
			this.publishTimer = undefined
			this.publishTimerWindow = undefined
			this.publishSelection()
		}, 75)
	}

	private publishSelection(): void {
		if (!this.root || !this.server || !this.isActiveWindowFocused()) return
		const event = selectionEvent(this.app, this.root)
		this.server.publishSelection(event)
	}

	private async mentionSelection(wholeNote: boolean): Promise<void> {
		const server = this.server
		if (!this.root || !server) return
		const event = mentionEvent(this.app, this.root, wholeNote)
		if (!event) {
			new Notice("No active Markdown note to mention.")
			return
		}
		const target = await pickMentionTarget(this.app, server)
		if (!target || this.server !== server) return
		server.sendMention(target, event)
	}

	private async cleanup(): Promise<void> {
		if (this.publishTimer !== undefined) {
			this.publishTimerWindow?.clearTimeout(this.publishTimer)
			this.publishTimer = undefined
			this.publishTimerWindow = undefined
		}
		const server = this.server
		this.server = undefined
		if (server) await server.stop()
		if (this.lockPath) await rm(this.lockPath, { force: true })
		this.lockPath = undefined
		this.port = undefined
	}
}
