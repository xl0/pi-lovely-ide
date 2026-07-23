import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent"
import * as v from "valibot"
import { CellAddressSchema, type IdeDiagnosticsEventParams, TextExcerptSchema } from "../../packages/protocol/src/index.js"
import { formatSelectedText, type SelectedTextLineLimit } from "./selection.js"

const persistedContexts = new Map<string, string>()

export const DiagnosticsSnapshotSchema = v.looseObject({
	ref: v.string(),
	scope: v.union([v.literal("selection"), v.literal("file"), v.literal("workspace")]),
	cell: v.optional(CellAddressSchema),
	lineRanges: v.optional(
		v.array(
			v.looseObject({
				start: v.pipe(v.number(), v.integer(), v.minValue(1)),
				end: v.pipe(v.number(), v.integer(), v.minValue(1)),
				text: TextExcerptSchema
			})
		)
	),
	documents: v.pipe(v.number(), v.integer(), v.minValue(0)),
	diagnostics: v.pipe(v.number(), v.integer(), v.minValue(0)),
	text: v.string()
})
export type DiagnosticsSnapshot = v.InferOutput<typeof DiagnosticsSnapshotSchema>

function formatLineRanges(ranges: { start: number; end: number }[]): string {
	return ranges.map(range => (range.start === range.end ? String(range.start) : `${range.start}-${range.end}`)).join(",")
}

function formatCell(cell: DiagnosticsSnapshot["cell"]): string {
	if (cell?.id !== undefined) return `[cell ${cell.id}]`
	if (cell?.index !== undefined) return `[cell ${cell.index}]`
	return ""
}

export function diagnosticsSnapshotFromEvent(event: IdeDiagnosticsEventParams, displayPath: (path: string) => string): DiagnosticsSnapshot {
	const lineRanges =
		event.scope === "selection"
			? event.selectionLines.map(range => ({ start: range.start + 1, end: range.end + 1, text: range.text }))
			: undefined
	const rangeRef = lineRanges ? `#${formatLineRanges(lineRanges)}` : ""
	const cell = event.scope === "workspace" ? undefined : event.cell
	const ref = `[problems: ${event.file ? displayPath(event.file) : "workspace"}${formatCell(cell)}${rangeRef}]`
	const diagnosticCount = event.documents.reduce((total, document) => total + document.diagnostics.length, 0)
	const output = event.documents
		.flatMap(document =>
			document.diagnostics.map(diagnostic => {
				let file = document.file ? displayPath(document.file) : document.uri
				if (!document.file) {
					try {
						if (document.uri.startsWith("file:")) file = displayPath(fileURLToPath(document.uri))
					} catch {
						// Preserve non-file or malformed URI for display.
					}
				}
				file += formatCell(document.cell)
				const start = diagnostic.range.start
				const label = [diagnostic.severity, diagnostic.source, diagnostic.code].filter(Boolean).join(" ")
				const message = diagnostic.message.replaceAll("\r\n", "\n").replaceAll("\n", "\n  ")
				return `${file}:${start.line + 1}:${start.character + 1} [${label}] ${message}`
			})
		)
		.join("\n")
	const empty = event.scope === "selection" ? "No code problems in selection." : "No code problems."
	return {
		ref,
		scope: event.scope,
		...(cell ? { cell } : {}),
		...(lineRanges ? { lineRanges } : {}),
		documents: event.documents.length,
		diagnostics: diagnosticCount,
		text: output || empty
	}
}

function persistContext(output: string): string {
	const key = createHash("sha256").update(output).digest("hex")
	const existing = persistedContexts.get(key)
	if (existing) return existing
	const path = join(tmpdir(), `pi-problems-${randomUUID()}.log`)
	try {
		writeFileSync(path, output, { encoding: "utf8", flag: "wx", mode: 0o600 })
	} catch (cause) {
		throw new Error(`Problems context exceeded output limits and could not be saved to ${path}`, { cause })
	}
	persistedContexts.set(key, path)
	return path
}

function formatSelectedCode(snapshot: DiagnosticsSnapshot, selectedTextLineLimit: SelectedTextLineLimit): string {
	return (snapshot.lineRanges ?? [])
		.flatMap(range => {
			const text = formatSelectedText(range.text, range.end - range.start + 1, selectedTextLineLimit)
			return text === undefined ? [] : [`<selected_code lines="${formatLineRanges([range])}">\n${text}\n</selected_code>`]
		})
		.join("\n")
}

export function formatDiagnosticsContext(snapshots: DiagnosticsSnapshot[], selectedTextLineLimit: SelectedTextLineLimit): string {
	const output = snapshots
		.map(snapshot => {
			const lines = snapshot.lineRanges?.length ? ` lines="${formatLineRanges(snapshot.lineRanges)}"` : ""
			const cellId = snapshot.cell?.id !== undefined ? ` cellId="${snapshot.cell.id}"` : ""
			const cellIndex = snapshot.cell?.index !== undefined ? ` cellIndex="${snapshot.cell.index}"` : ""
			const code = formatSelectedCode(snapshot, selectedTextLineLimit)
			const body = code ? `${code}\n\n${snapshot.text}` : snapshot.text
			return `<problems ref="${snapshot.ref}" scope="${snapshot.scope}"${cellId}${cellIndex}${lines}>\n${body}\n</problems>`
		})
		.join("\n")
	const truncation = truncateHead(output)
	if (!truncation.truncated) return output
	const path = persistContext(output)
	const note = `[Problems context truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${path}]`
	return `${truncation.content}${truncation.content ? "\n\n" : ""}${note}`
}
