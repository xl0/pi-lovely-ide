import { relative } from "node:path"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import Type, { type Static } from "typebox"
import {
	CellAddressSchema,
	type IdeEventParams,
	type IdeSpan,
	type IdeTextExcerpt,
	type NotebookCellAddress,
	TextExcerptSchema
} from "../../packages/protocol/src/index.js"

export const SELECTED_TEXT_LINE_LIMITS = [0, 3, 5, 9] as const
export type SelectedTextLineLimit = (typeof SELECTED_TEXT_LINE_LIMITS)[number]
export const DEFAULT_SELECTED_TEXT_LINE_LIMIT: SelectedTextLineLimit = 3

export const SelectionRangeSnapshotSchema = Type.Object(
	{
		lineStart: Type.Integer({ minimum: 1 }),
		lineEnd: Type.Integer({ minimum: 1 }),
		characterStart: Type.Integer({ minimum: 1 }),
		characterEnd: Type.Integer({ minimum: 1 }),
		isCursor: Type.Boolean()
	},
	{ additionalProperties: true }
)
export type SelectionRangeSnapshot = Static<typeof SelectionRangeSnapshotSchema>

export const SelectionSnapshotSchema = Type.Object(
	{
		filePath: Type.String(),
		cell: Type.Optional(CellAddressSchema),
		range: Type.Optional(SelectionRangeSnapshotSchema),
		text: Type.Optional(TextExcerptSchema)
	},
	{ additionalProperties: true }
)
export type SelectionSnapshot = Static<typeof SelectionSnapshotSchema>

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>

export function displayPathForCwd(cwd: string | undefined, path: string): string {
	if (!cwd) return path
	const rel = relative(cwd, path)
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : path
}

export function lineRangeText(lineStart: number, lineEnd: number): string {
	return lineStart === lineEnd ? String(lineStart) : `${lineStart}-${lineEnd}`
}

function selectionLineRange(span: IdeSpan): SelectionRangeSnapshot | undefined {
	const range = span.range
	if (!range) return undefined
	const isCursor = range.start.line === range.end.line && range.start.character === range.end.character
	const lineStart = range.start.line + 1
	const lineEnd = range.end.line + 1
	if (lineEnd < lineStart) return undefined
	return {
		lineStart,
		lineEnd,
		characterStart: range.start.character + 1,
		characterEnd: range.end.character + 1,
		isCursor
	}
}

function snapshotCell(cell: IdeSpan["cell"]): NotebookCellAddress | undefined {
	if (!cell) return undefined
	return {
		...(cell.index !== undefined ? { index: cell.index } : {}),
		...(cell.id !== undefined ? { id: cell.id } : {})
	}
}

function snapshotText(span: IdeSpan): IdeTextExcerpt | undefined {
	return span.text && span.text.totalCharacters > 0 ? span.text : undefined
}

export function selectionSnapshotFromEvent(selection: IdeEventParams): SelectionSnapshot | undefined {
	if (!selection.file) return undefined
	const span = selection.spans[0]
	if (!span) return { filePath: selection.file }

	const cell = snapshotCell(span.cell)
	const range = selectionLineRange(span)
	if (!range && !cell) return undefined
	const text = snapshotText(span)
	const snapshot: SelectionSnapshot = {
		filePath: selection.file,
		...(cell !== undefined ? { cell } : {}),
		...(range !== undefined ? { range } : {})
	}
	if (text) snapshot.text = text
	return snapshot
}

export function appendContextToContent(content: ContextUserMessage["content"], context: string): ContextUserMessage["content"] {
	const suffix = `\n\n${context}`
	if (typeof content === "string") return `${content}${suffix}`
	return [...content, { type: "text", text: suffix }]
}

function omittedLinesMarker(lineCount: number): string {
	return lineCount > 0 ? `[ ... ${lineCount} lines ... ]` : "[ ... omitted text ... ]"
}

function linesOf(text: string): string[] {
	return text.split(/\r?\n/)
}

function markEndTruncated(lines: string[]): string[] {
	return lines.length ? [...lines.slice(0, -1), `${lines.at(-1)}…`] : lines
}

function markStartTruncated(lines: string[]): string[] {
	return lines.length ? [`…${lines[0]}`, ...lines.slice(1)] : lines
}

function formatSelectedText(excerpt: IdeTextExcerpt, fallbackTotalLineCount: number, lineLimit: SelectedTextLineLimit): string | undefined {
	if (lineLimit === 0 || excerpt.totalCharacters === 0) return undefined
	const totalLineCount = excerpt.totalLines ?? fallbackTotalLineCount
	const headLines = linesOf(excerpt.head)
	const fullText = excerpt.tail === undefined && !excerpt.headTruncated && excerpt.head.length === excerpt.totalCharacters
	if (fullText && headLines.length <= lineLimit) return excerpt.head

	const edgeLines = Math.floor(lineLimit / 2)
	if (fullText) {
		const skipped = Math.max(0, headLines.length - edgeLines * 2)
		return [...headLines.slice(0, edgeLines), omittedLinesMarker(skipped), ...headLines.slice(-edgeLines)].join("\n")
	}

	const tailLines = excerpt.tail !== undefined ? linesOf(excerpt.tail) : []
	let shownHead = headLines.slice(0, edgeLines)
	let shownTail = tailLines.slice(-edgeLines)
	if (excerpt.headTruncated && shownHead.length === headLines.length) shownHead = markEndTruncated(shownHead)
	if (excerpt.tailTruncated && shownTail.length === tailLines.length) shownTail = markStartTruncated(shownTail)
	const skipped = Math.max(0, totalLineCount - shownHead.length - shownTail.length)
	return [...shownHead, omittedLinesMarker(skipped), ...shownTail].join("\n")
}

export function formatSnapshotReference(
	snapshot: SelectionSnapshot,
	displayPath: (path: string) => string,
	options: { prefix?: string; collapseCursor?: boolean } = {}
): string {
	let ref = `${options.prefix ?? ""}${displayPath(snapshot.filePath)}`
	if (snapshot.cell?.id !== undefined) ref += `[cell ${snapshot.cell.id}]`
	else if (snapshot.cell?.index !== undefined) ref += `[cell ${snapshot.cell.index + 1}]`
	else if (snapshot.cell) ref += "[cell]"
	if (!snapshot.range) return ref
	if (snapshot.range.isCursor && options.collapseCursor) return `${ref}#${snapshot.range.lineStart}:${snapshot.range.characterStart}`
	ref += `#${snapshot.range.lineStart}:${snapshot.range.characterStart}-${snapshot.range.lineEnd}:${snapshot.range.characterEnd}`
	return ref
}

export function formatSnapshotContext(
	snapshot: SelectionSnapshot,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit = DEFAULT_SELECTED_TEXT_LINE_LIMIT,
	tag = "selection",
	extraAttributes = ""
): string {
	const file = displayPath(snapshot.filePath)
	let attributes = `file="${file}"`
	if (snapshot.cell?.id !== undefined) attributes += ` cellId="${snapshot.cell.id}"`
	if (snapshot.cell?.index !== undefined) attributes += ` cellIndex="${snapshot.cell.index + 1}"`
	attributes += extraAttributes
	if (!snapshot.range) {
		const text =
			snapshot.text !== undefined ? formatSelectedText(snapshot.text, snapshot.text.totalLines ?? 1, selectedTextLineLimit) : undefined
		return text !== undefined ? `<${tag} ${attributes}>\n${text}\n</${tag}>` : `<${tag} ${attributes} />`
	}

	const element = snapshot.range.isCursor && tag === "selection" ? "cursor" : tag
	if (snapshot.range.isCursor) return `<${element} ${attributes} position="${snapshot.range.lineStart}:${snapshot.range.characterStart}" />`

	const range = `${snapshot.range.lineStart}:${snapshot.range.characterStart}-${snapshot.range.lineEnd}:${snapshot.range.characterEnd}`
	const text =
		snapshot.text !== undefined
			? formatSelectedText(snapshot.text, snapshot.range.lineEnd - snapshot.range.lineStart + 1, selectedTextLineLimit)
			: undefined
	if (text !== undefined) {
		return `<${tag} ${attributes} range="${range}">\n${text}\n</${tag}>`
	}
	return `<${tag} ${attributes} range="${range}" />`
}

export function formatSelectionContext(
	snapshot: SelectionSnapshot,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit = DEFAULT_SELECTED_TEXT_LINE_LIMIT
): string {
	return formatSnapshotContext(snapshot, displayPath, selectedTextLineLimit)
}

export class SelectionState {
	#current: SelectionSnapshot | null = null

	constructor(private readonly displayPath: (path: string) => string) {}

	setCurrent(selection: IdeEventParams): void {
		this.#current = selectionSnapshotFromEvent(selection) ?? null
	}

	clearCurrent(): void {
		this.#current = null
	}

	snapshotCurrent(): SelectionSnapshot | null {
		return this.#current
	}

	describeCurrent(): string | undefined {
		return this.#current ? formatSnapshotReference(this.#current, this.displayPath, { collapseCursor: true }) : undefined
	}
}
