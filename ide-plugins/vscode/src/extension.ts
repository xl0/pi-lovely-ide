import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { type WebSocket, WebSocketServer } from "ws"
import {
	type HelloParams,
	type IdeDiagnostic,
	type IdeDiagnosticsDocument,
	type IdeDiagnosticsEventParams,
	type IdeEventParams,
	type IdeLocationEventParams,
	type IdeSelectedLineRange,
	type IdeSpan,
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
const MAX_SPAN_TEXT_EDGE_CHARS = 2 * 1024
const MAX_SPAN_TEXT_EDGE_LINES = 20

function spanSummary(span: IdeSpan): string {
	const cell = span.cell ? ` cell=${span.cell.index ?? "?"}${span.cell.id ? `:${span.cell.id}` : ""}` : ""
	const range = span.range
		? ` range=${span.range.start.line}:${span.range.start.character}-${span.range.end.line}:${span.range.end.character}`
		: ""
	const text = span.text
		? ` text=${span.text.head.length}${span.text.tail !== undefined ? `+${span.text.tail.length}` : ""}/${span.text.totalCharacters}`
		: ""
	return `${cell}${range}${text}`.trim()
}

function eventSummary(event: IdeEventParams): string {
	if (event.type === "diagnostics") {
		const count = event.documents.reduce((total, document) => total + document.diagnostics.length, 0)
		return `diagnostics scope=${event.scope} file=${event.file ?? "<workspace>"} documents=${event.documents.length} diagnostics=${count}`
	}
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

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): IdeDiagnostic["severity"] {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return "Error"
		case vscode.DiagnosticSeverity.Warning:
			return "Warning"
		case vscode.DiagnosticSeverity.Information:
			return "Information"
		case vscode.DiagnosticSeverity.Hint:
			return "Hint"
	}
}

function diagnosticCode(code: vscode.Diagnostic["code"]): string | undefined {
	if (code == null) return undefined
	return String(typeof code === "object" ? code.value : code)
}

function protocolDiagnostic(diagnostic: vscode.Diagnostic): IdeDiagnostic {
	const code = diagnosticCode(diagnostic.code)
	return {
		message: diagnostic.message,
		severity: diagnosticSeverity(diagnostic.severity),
		range: {
			start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
			end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character }
		},
		...(diagnostic.source ? { source: diagnostic.source } : {}),
		...(code ? { code } : {})
	}
}

function diagnosticsDocument(
	uri: vscode.Uri,
	diagnostics: readonly vscode.Diagnostic[],
	notebookCell?: vscode.NotebookCell
): IdeDiagnosticsDocument {
	return {
		uri: uri.toString(),
		...(notebookCell ? { file: notebookCell.notebook.uri.fsPath, cell: cellAddress(notebookCell) } : {}),
		diagnostics: diagnostics.map(protocolDiagnostic)
	}
}

function selectedLineCount(range: vscode.Range): number {
	if (range.end.line === range.start.line) return 1
	return range.end.character === 0 ? range.end.line - range.start.line : range.end.line - range.start.line + 1
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

function textForRange(document: vscode.TextDocument, range: vscode.Range): Pick<IdeSpan, "text"> {
	const start = document.offsetAt(range.start)
	const end = document.offsetAt(range.end)
	if (end <= start) return {}
	return { text: excerptForText(document.getText(range), selectedLineCount(range)) }
}

function endLineBeforeTrailingNewline(document: vscode.TextDocument, selection: vscode.Selection): vscode.Position | undefined {
	return !selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line
		? document.lineAt(selection.end.line - 1).range.end
		: undefined
}

function textRangeForSelection(document: vscode.TextDocument, selection: vscode.Selection): vscode.Range {
	const lineEnd = endLineBeforeTrailingNewline(document, selection)
	return lineEnd ? new vscode.Range(selection.start, lineEnd) : selection
}

function rangeForSelection(document: vscode.TextDocument, selection: vscode.Selection): NonNullable<IdeSpan["range"]> {
	const lineEnd = endLineBeforeTrailingNewline(document, selection)
	const end = lineEnd ? new vscode.Position(lineEnd.line, Math.max(0, lineEnd.character - 1)) : selection.end
	return {
		start: { line: selection.start.line, character: selection.start.character },
		end: { line: end.line, character: end.character }
	}
}

function cellAddress(cell: vscode.NotebookCell): NonNullable<IdeSpan["cell"]> {
	const id = typeof cell.metadata.id === "string" ? cell.metadata.id : undefined
	return { index: cell.index, ...(id ? { id } : {}) }
}

function findNotebookCell(document: vscode.TextDocument): vscode.NotebookCell | undefined {
	const documentUri = document.uri.toString()
	for (const cell of vscode.window.activeNotebookEditor?.notebook.getCells() ?? []) {
		if (cell.document === document || cell.document.uri.toString() === documentUri) return cell
	}
	return undefined
}

function findOpenNotebookCell(uri: vscode.Uri): vscode.NotebookCell | undefined {
	const documentUri = uri.toString()
	for (const notebook of vscode.workspace.notebookDocuments) {
		for (const cell of notebook.getCells()) {
			if (cell.document.uri.toString() === documentUri) return cell
		}
	}
	return undefined
}

function spansForSelections(document: vscode.TextDocument, selections: readonly vscode.Selection[]): IdeSpan[] {
	return selections.map(selection => ({
		range: rangeForSelection(document, selection),
		...textForRange(document, textRangeForSelection(document, selection))
	}))
}

function eventForTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent): IdeLocationEventParams | undefined {
	if (event.textEditor.document.uri.scheme === "vscode-notebook-cell") {
		const cell = findNotebookCell(event.textEditor.document)
		return cell
			? {
					type: "selection",
					file: cell.notebook.uri.fsPath,
					spans: spansForSelections(cell.document, event.selections).map(span => ({ cell: cellAddress(cell), ...span }))
				}
			: undefined
	}
	return {
		type: "selection",
		file: event.textEditor.document.uri.fsPath,
		spans: spansForSelections(event.textEditor.document, event.selections)
	}
}

function currentMentionEvent(): IdeLocationEventParams | undefined {
	const editor = vscode.window.activeTextEditor
	if (!editor) return undefined
	if (editor.document.uri.scheme === "vscode-notebook-cell") {
		const cell = findNotebookCell(editor.document)
		if (!cell) return undefined
		const spans = spansForSelections(cell.document, editor.selections).map(span => ({ cell: cellAddress(cell), ...span }))
		return spans.length > 0 ? { type: "mention", file: cell.notebook.uri.fsPath, spans } : undefined
	}
	return { type: "mention", file: editor.document.uri.fsPath, spans: spansForSelections(editor.document, editor.selections) }
}

function label(conn: PiConnection): string {
	const s = conn.hello.session
	const c = conn.hello.client
	return `${s.name ?? s.id} (${c.name} pid ${c.pid}${c.mode ? ` ${c.mode}` : ""})`
}

async function pickTarget(subscription: "mention" | "diagnostics", emptyMessage: string): Promise<PiConnection | undefined> {
	const targets = [...connections.values()].filter(conn => conn.hello.connection.subscriptions?.includes(subscription))
	const subject = subscription === "diagnostics" ? "problems" : subscription
	let target = targets[0]
	if (!target) {
		void vscode.window.showInformationMessage(emptyMessage)
		return undefined
	}
	if (targets.length > 1) {
		const picked = await vscode.window.showQuickPick(
			targets.map(conn => ({ label: label(conn), conn })),
			{ placeHolder: `Send ${subject} to Pi` }
		)
		if (!picked) return undefined
		target = picked.conn
	}
	return target
}

async function mentionSelection(): Promise<void> {
	const event = currentMentionEvent()
	if (!event) {
		void vscode.window.showWarningMessage("No active editor selection to mention")
		return
	}
	logChannel?.info(`Mention command ${eventSummary(event)}`)
	const target = await pickTarget("mention", "No Pi agent subscribed to mentions.")
	if (!target) return
	logChannel?.debug(`Send ${eventSummary(event)} to ${label(target)}`)
	send(target.socket, { jsonrpc: "2.0", method: "event", params: event })
}

function intersectsSelection(diagnostic: vscode.Diagnostic, selection: vscode.Selection): boolean {
	if (diagnostic.range.isEmpty) {
		return !diagnostic.range.start.isBefore(selection.start) && diagnostic.range.start.isBefore(selection.end)
	}
	return selection.start.isBefore(diagnostic.range.end) && diagnostic.range.start.isBefore(selection.end)
}

function selectedLineRange(document: vscode.TextDocument, selection: vscode.Selection): IdeSelectedLineRange {
	const end = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line
	const text = Array.from(
		{ length: end - selection.start.line + 1 },
		(_, index) => document.lineAt(selection.start.line + index).text
	).join("\n")
	return { start: selection.start.line, end, text: excerptForText(text, end - selection.start.line + 1) }
}

function currentDiagnosticsEvent(): IdeDiagnosticsEventParams | undefined {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		void vscode.window.showWarningMessage("No active editor to attach problems from")
		return undefined
	}
	const selections = editor.selections.filter(selection => !selection.isEmpty)
	const diagnostics = vscode.languages
		.getDiagnostics(editor.document.uri)
		.filter(diagnostic => selections.length === 0 || selections.some(selection => intersectsSelection(diagnostic, selection)))
	if (selections.length && diagnostics.length === 0) {
		void vscode.window.showInformationMessage("No problems in selection.")
		return undefined
	}
	let file = editor.document.uri.fsPath
	let cell: ReturnType<typeof cellAddress> | undefined
	let notebookCell: vscode.NotebookCell | undefined
	if (editor.document.uri.scheme === "vscode-notebook-cell") {
		notebookCell = findNotebookCell(editor.document)
		if (!notebookCell) {
			void vscode.window.showWarningMessage("Active notebook cell could not be resolved")
			return undefined
		}
		file = notebookCell.notebook.uri.fsPath
		cell = cellAddress(notebookCell)
	}
	const documents = [diagnosticsDocument(editor.document.uri, diagnostics, notebookCell)]
	if (selections.length) {
		const selectionLines = selections
			.map(selection => selectedLineRange(editor.document, selection))
			.sort((a, b) => a.start - b.start || a.end - b.end)
		return {
			type: "diagnostics",
			scope: "selection",
			file,
			...(cell ? { cell } : {}),
			selectionLines,
			documents
		}
	}
	return { type: "diagnostics", scope: "file", file, ...(cell ? { cell } : {}), documents }
}

function workspaceDiagnosticsEvent(): IdeDiagnosticsEventParams | undefined {
	const documents = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
		if (diagnostics.length === 0) return []
		const notebookCell = uri.scheme === "vscode-notebook-cell" ? findOpenNotebookCell(uri) : undefined
		if (!vscode.workspace.getWorkspaceFolder(notebookCell?.notebook.uri ?? uri)) return []
		return [diagnosticsDocument(uri, diagnostics, notebookCell)]
	})
	if (documents.length === 0) {
		void vscode.window.showInformationMessage("No workspace problems.")
		return undefined
	}
	return { type: "diagnostics", scope: "workspace", file: null, documents }
}

async function attachDiagnostics(event: IdeDiagnosticsEventParams): Promise<void> {
	logChannel?.info(`Diagnostics command ${eventSummary(event)}`)
	const target = await pickTarget("diagnostics", "No Pi agent available for problems.")
	if (!target) return
	logChannel?.debug(`Send ${eventSummary(event)} to ${label(target)}`)
	send(target.socket, { jsonrpc: "2.0", method: "event", params: event })
}

function handleMessage(socket: WebSocket, raw: string): void {
	const parsed = parseIdeMessage(raw)
	if (!parsed) {
		logChannel?.warn(`Ignored invalid JSON-RPC message (${raw.length} chars)`)
		return
	}
	const msg = parsed.message

	switch (parsed.kind) {
		case "hello": {
			if (parsed.params.version !== PI_IDE_PROTOCOL_VERSION) {
				logChannel?.warn(`Rejected hello with unsupported protocol version ${parsed.params.version}`)
				send(socket, { jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: "unsupported protocol version" } })
				return
			}
			const conn: PiConnection = { socket, hello: parsed.params }
			connections.set(socket, conn)
			logChannel?.info(`Accepted hello from ${label(conn)} workspace=${parsed.params.workspace}`)
			send(socket, {
				jsonrpc: "2.0",
				id: parsed.id,
				result: {
					version: PI_IDE_PROTOCOL_VERSION,
					ide: { name: vscode.env.appName, version: vscode.version }
				}
			})
			return
		}
		case "ping":
			send(socket, { jsonrpc: "2.0", id: parsed.id, result: {} })
			return
		case "session_info_changed": {
			const conn = connections.get(socket)
			if (!conn) return
			if (parsed.params.name) conn.hello.session.name = parsed.params.name
			else delete conn.hello.session.name
			logChannel?.info(`Updated session info for ${label(conn)}`)
			return
		}
		case "jsonrpc":
			if (msg.method === "hello" && msg.id != null) {
				logChannel?.warn("Rejected invalid hello")
				send(socket, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid hello" } })
			} else if (msg.method != null && msg.id != null) {
				logChannel?.warn(`Rejected unknown request method ${msg.method}`)
				send(socket, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
			}
			return
		case "event":
			return
	}
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
		vscode.commands.registerCommand("pi-lovely-ide.attachDiagnostics", () => {
			const event = currentDiagnosticsEvent()
			if (event) return attachDiagnostics(event)
		}),
		vscode.commands.registerCommand("pi-lovely-ide.attachWorkspaceDiagnostics", () => {
			const event = workspaceDiagnosticsEvent()
			if (event) return attachDiagnostics(event)
		}),
		vscode.window.onDidChangeTextEditorSelection(event => {
			if (event.textEditor.document.uri.scheme === "output") return
			logVsCodeEvent("onDidChangeTextEditorSelection", JSON.stringify(event))
			const selection = eventForTextEditorSelection(event)
			if (!selection) return
			const key = JSON.stringify(selection)
			for (const conn of connections.values()) {
				if (!conn.hello.connection.subscriptions?.includes("selection")) continue
				if (selection.spans.length === 0) {
					if (!lastSelectionKeys.has(conn.socket)) continue
					lastSelectionKeys.delete(conn.socket)
					logChannel?.debug(`Clear selection for ${label(conn)}`)
					send(conn.socket, { jsonrpc: "2.0", method: "event", params: { type: "selection", file: null, spans: [] } })
					continue
				}
				if (lastSelectionKeys.get(conn.socket) === key) continue
				lastSelectionKeys.set(conn.socket, key)
				logChannel?.debug(`Send ${eventSummary(selection)} to ${label(conn)}`)
				send(conn.socket, { jsonrpc: "2.0", method: "event", params: selection })
			}
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
