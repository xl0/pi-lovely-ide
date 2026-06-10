import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { type WebSocket, WebSocketServer } from "ws"
import {
	type HelloParams,
	type IdeEventParams,
	type IdeSpan,
	type JsonRpcId,
	type JsonRpcMessage,
	PI_IDE_AUTH_HEADER,
	PI_IDE_PROTOCOL,
	PI_IDE_PROTOCOL_VERSION,
	parseIdeLockFile,
	parseIdeMessage
} from "../../../packages/protocol/src/index.js"

interface PiConnection {
	socket: WebSocket
	hello: HelloParams
}

let server: WebSocketServer | undefined
let port: number | undefined
let token: string | undefined
let lockPath: string | undefined
let logChannel: vscode.LogOutputChannel | undefined
const connections = new Map<WebSocket, PiConnection>()
const lastSelectionKeys = new Map<WebSocket, string>()
const MAX_SPAN_TEXT_CHARS = 2 * 1024
const TRUNCATED_TEXT_SUFFIX = "\n… [truncated]"

function spanSummary(span: IdeSpan): string {
	const cell = span.cell ? ` cell=${span.cell.index ?? "?"}${span.cell.id ? `:${span.cell.id}` : ""}` : ""
	const range = span.range
		? ` range=${span.range.start.line}:${span.range.start.character}-${span.range.end.line}:${span.range.end.character}`
		: " range=whole"
	const text = typeof span.text === "string" ? ` text=${span.text.length}` : ""
	return `${cell}${range}${text}`.trim()
}

function eventSummary(event: IdeEventParams): string {
	return `${event.type} file=${event.file ?? "<none>"} spans=${event.spans.length}${event.spans.map(span => ` [${spanSummary(span)}]`).join("")}`
}

function logVsCodeEvent(name: string, details: string): void {
	logChannel?.debug(`Event ${name}: ${details}`)
}

function lockDir(): string {
	return join(homedir(), ".pi", "ide")
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
				if (lock?.pid && !isPidAlive(lock.pid)) {
					await rm(path, { force: true })
					logChannel?.debug(`Removed stale lockfile ${path}`)
				}
			} catch {
				// Non-pi or unreadable lock; leave it.
			}
		})
	)
}

function workspaceFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
}

async function writeLockFile(): Promise<void> {
	if (!port || !token) return
	await mkdir(lockDir(), { recursive: true })
	lockPath = join(lockDir(), `${port}.lock`)
	await writeFile(
		lockPath,
		JSON.stringify(
			{
				protocol: PI_IDE_PROTOCOL,
				version: PI_IDE_PROTOCOL_VERSION,
				port,
				pid: process.pid,
				workspaces: workspaceFolders(),
				ide: vscode.env.appName,
				token
			},
			null,
			"\t"
		)
	)
	logChannel?.info(`Wrote lockfile ${lockPath}`)
}

function send(socket: WebSocket, message: JsonRpcMessage): void {
	if (socket.readyState === 1) socket.send(JSON.stringify(message))
}

function response(id: JsonRpcId, result: unknown): JsonRpcMessage {
	return { jsonrpc: "2.0", id, result }
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
	return { jsonrpc: "2.0", id, error: { code, message } }
}

function subscriptions(conn: PiConnection): Set<string> {
	return new Set(conn.hello.connection.subscriptions ?? [])
}

function maybeText(text: string): Pick<IdeSpan, "text"> {
	return text.length > 0 ? { text } : {}
}

function textForRange(document: vscode.TextDocument, range: vscode.Range): Pick<IdeSpan, "text"> {
	const start = document.offsetAt(range.start)
	const end = document.offsetAt(range.end)
	if (end <= start) return {}

	const truncated = end - start > MAX_SPAN_TEXT_CHARS
	const limit = MAX_SPAN_TEXT_CHARS - (truncated ? TRUNCATED_TEXT_SUFFIX.length : 0)
	const prefixEnd = document.positionAt(Math.min(end, start + limit))
	const text = document.getText(new vscode.Range(range.start, prefixEnd))
	return maybeText(truncated ? `${text}${TRUNCATED_TEXT_SUFFIX}` : text)
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
	const lastLine = document.lineAt(Math.max(0, document.lineCount - 1))
	return new vscode.Range(0, 0, lastLine.lineNumber, lastLine.range.end.character)
}

function cellAddress(cell: vscode.NotebookCell): NonNullable<IdeSpan["cell"]> {
	const id = typeof cell.metadata.id === "string" ? cell.metadata.id : undefined
	return { index: cell.index, ...(id ? { id } : {}) }
}

function findNotebookCell(document: vscode.TextDocument): vscode.NotebookCell | undefined {
	const notebooks = [
		...(vscode.window.activeNotebookEditor ? [vscode.window.activeNotebookEditor.notebook] : []),
		...vscode.window.visibleNotebookEditors.map(editor => editor.notebook),
		...vscode.workspace.notebookDocuments
	]
	const documentUri = document.uri.toString()
	const seen = new Set<string>()
	for (const notebook of notebooks) {
		const notebookUri = notebook.uri.toString()
		if (seen.has(notebookUri)) continue
		seen.add(notebookUri)
		for (let i = 0; i < notebook.cellCount; i++) {
			const cell = notebook.cellAt(i)
			if (cell.document === document || cell.document.uri.toString() === documentUri) return cell
		}
	}
	return undefined
}

function spansForSelections(document: vscode.TextDocument, selections: readonly vscode.Selection[]): IdeSpan[] {
	return selections.map(selection => ({
		range: {
			start: { line: selection.start.line, character: selection.start.character },
			end: { line: selection.end.line, character: selection.end.character }
		},
		...textForRange(document, selection)
	}))
}

function eventForEditor(editor: vscode.TextEditor | undefined, type: "selection" | "mention"): IdeEventParams {
	if (!editor) return { type, file: null, spans: [] }
	return { type, file: editor.document.uri.fsPath, spans: spansForSelections(editor.document, editor.selections) }
}

function eventForTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent): IdeEventParams {
	const cell = findNotebookCell(event.textEditor.document)
	if (cell) {
		return {
			type: "selection",
			file: cell.notebook.uri.fsPath,
			spans: spansForSelections(cell.document, event.selections).map(span => ({ cell: cellAddress(cell), ...span }))
		}
	}
	return { type: "selection", file: event.textEditor.document.uri.fsPath, spans: spansForSelections(event.textEditor.document, event.selections) }
}

function eventForNotebookCellEditor(editor: vscode.TextEditor | undefined, type: "selection" | "mention"): IdeEventParams | undefined {
	if (!editor) return undefined
	const cell = findNotebookCell(editor.document)
	if (!cell) return undefined
	const spans = spansForSelections(cell.document, editor.selections).map(span => ({ cell: cellAddress(cell), ...span }))
	return spans.length > 0 ? { type, file: cell.notebook.uri.fsPath, spans } : undefined
}

function eventForNotebookCells(type: "selection" | "mention", includeSingleCell: boolean): IdeEventParams | undefined {
	const editor = vscode.window.activeNotebookEditor
	if (!editor) return undefined
	const spans: IdeSpan[] = []
	for (const selection of editor.selections) {
		if (!includeSingleCell && selection.end - selection.start <= 1) continue
		for (let i = selection.start; i < selection.end; i++) {
			const cell = editor.notebook.cellAt(i)
			spans.push({ cell: cellAddress(cell), ...textForRange(cell.document, fullDocumentRange(cell.document)) })
		}
	}
	return spans.length > 0 ? { type, file: editor.notebook.uri.fsPath, spans } : undefined
}

function currentEvent(type: "selection" | "mention", includeSingleNotebookCell = false): IdeEventParams {
	return (
		eventForNotebookCellEditor(vscode.window.activeTextEditor, type) ??
		eventForNotebookCells(type, includeSingleNotebookCell) ??
		eventForEditor(vscode.window.activeTextEditor, type)
	)
}

function publish(event: IdeEventParams, target?: PiConnection): void {
	for (const conn of target ? [target] : connections.values()) {
		if (!subscriptions(conn).has(event.type)) continue
		logChannel?.debug(`Send ${eventSummary(event)} to ${label(conn)}`)
		send(conn.socket, { jsonrpc: "2.0", method: "event", params: event })
	}
}

function publishSelection(event: IdeEventParams): void {
	const key = JSON.stringify(event)

	for (const conn of connections.values()) {
		if (!subscriptions(conn).has("selection")) continue
		if (event.spans.length > 0) {
			if (lastSelectionKeys.get(conn.socket) === key) continue
			lastSelectionKeys.set(conn.socket, key)
			logChannel?.debug(`Send ${eventSummary(event)} to ${label(conn)}`)
			send(conn.socket, { jsonrpc: "2.0", method: "event", params: event })
			continue
		}

		if (lastSelectionKeys.has(conn.socket)) {
			lastSelectionKeys.delete(conn.socket)
			logChannel?.debug(`Clear selection for ${label(conn)}`)
			send(conn.socket, { jsonrpc: "2.0", method: "event", params: { type: "selection", file: null, spans: [] } })
		}
	}
}

function label(conn: PiConnection): string {
	const s = conn.hello.session
	const c = conn.hello.client
	return `${s.name ?? s.id} (${c.name} pid ${c.pid}${c.mode ? ` ${c.mode}` : ""})`
}

async function mentionSelection(): Promise<void> {
	const event = currentEvent("mention", true)
	logChannel?.info(`Mention command ${eventSummary(event)}`)
	const targets = [...connections.values()].filter(conn => subscriptions(conn).has("mention"))
	if (targets.length === 0) {
		void vscode.window.showInformationMessage("No Pi connection subscribed to mentions")
		return
	}
	let target = targets[0]
	if (targets.length > 1) {
		const picked = await vscode.window.showQuickPick(
			targets.map(conn => ({ label: label(conn), conn })),
			{ placeHolder: "Send mention to Pi" }
		)
		if (!picked) return
		target = picked.conn
	}
	publish(event, target)
}

function handleMessage(socket: WebSocket, raw: string): void {
	const parsed = parseIdeMessage(raw)
	if (!parsed) {
		logChannel?.warn(`Ignored invalid JSON-RPC message (${raw.length} chars)`)
		return
	}
	const msg = parsed.message

	if (parsed.kind === "hello") {
		if (parsed.params.version !== PI_IDE_PROTOCOL_VERSION) {
			logChannel?.warn(`Rejected hello with unsupported protocol version ${parsed.params.version}`)
			send(socket, errorResponse(parsed.id, -32000, "unsupported protocol version"))
			return
		}
		const conn: PiConnection = { socket, hello: parsed.params }
		connections.set(socket, conn)
		logChannel?.info(`Accepted hello from ${label(conn)} workspace=${parsed.params.workspace}`)
		send(socket, response(parsed.id, { version: PI_IDE_PROTOCOL_VERSION, ide: { name: vscode.env.appName, version: vscode.version } }))
		return
	}

	if (msg.method === "hello" && msg.id != null) {
		logChannel?.warn("Rejected invalid hello")
		send(socket, errorResponse(msg.id, -32602, "invalid hello"))
		return
	}

	if (parsed.kind === "ping") send(socket, response(parsed.id, {}))
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	logChannel = vscode.window.createOutputChannel("Pi Lovely IDE", { log: true })
	logChannel.info(`Activating ${vscode.env.appName} ${vscode.version}`)
	token = randomBytes(32).toString("hex")
	await mkdir(lockDir(), { recursive: true })
	await cleanupStaleLocks()

	server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
	await new Promise<void>(resolve => server?.once("listening", resolve))
	const address = server.address()
	if (typeof address !== "object" || !address) throw new Error("Pi IDE server failed to bind")
	port = address.port
	logChannel.info(`Server listening on 127.0.0.1:${port}`)
	await writeLockFile()

	server.on("connection", (socket, request) => {
		if (request.headers[PI_IDE_AUTH_HEADER.toLowerCase()] !== token) {
			logChannel?.warn("Rejected WebSocket connection: bad auth")
			socket.close(1008, "bad auth")
			return
		}
		logChannel?.info("Accepted WebSocket connection")
		socket.on("message", data => handleMessage(socket, data.toString()))
		socket.on("close", () => {
			const conn = connections.get(socket)
			logChannel?.info(`Closed WebSocket connection${conn ? ` from ${label(conn)}` : ""}`)
			connections.delete(socket)
			lastSelectionKeys.delete(socket)
		})
	})

	context.subscriptions.push(
		vscode.commands.registerCommand("pi-lovely-ide.mentionSelection", mentionSelection),
		vscode.window.onDidChangeTextEditorSelection(event => {
			if (event.textEditor.document.uri.scheme === "output") return
			logVsCodeEvent("onDidChangeTextEditorSelection", JSON.stringify(event))
			publishSelection(eventForTextEditorSelection(event))
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(event => {
			logVsCodeEvent(
				"onDidChangeWorkspaceFolders",
				`added=${event.added.map(folder => folder.uri.toString()).join(",")} removed=${event.removed.map(folder => folder.uri.toString()).join(",")}`
			)
			void writeLockFile()
		}),
		{ dispose: () => void deactivate() }
	)
}

export async function deactivate(): Promise<void> {
	logChannel?.info("Deactivating")
	for (const socket of connections.keys()) socket.close()
	connections.clear()
	lastSelectionKeys.clear()
	server?.close()
	server = undefined
	if (lockPath) await rm(lockPath, { force: true })
	lockPath = undefined
	logChannel?.dispose()
	logChannel = undefined
}
