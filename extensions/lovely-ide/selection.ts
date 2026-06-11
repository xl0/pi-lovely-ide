import { relative } from "node:path"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import type { IdeEventParams, IdeSpan, IdeTextExcerpt } from "../../packages/protocol/src/index.js"

export const SELECTED_TEXT_LINE_LIMITS = [0, 3, 5, 9] as const
export type SelectedTextLineLimit = (typeof SELECTED_TEXT_LINE_LIMITS)[number]
export const DEFAULT_SELECTED_TEXT_LINE_LIMIT: SelectedTextLineLimit = 3
function rangedSpan(selection: IdeEventParams): IdeSpan | undefined {
	return selection.spans.find(s => s.range)
}
export interface SelectionSnapshot {
	filePath: string
	lineStart: number
	lineEnd: number
	characterStart: number
	characterEnd: number
	isCursor: boolean
	text?: IdeTextExcerpt
}

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>
interface SelectionLineRange {
	lineStart: number
	lineEnd: number
	characterStart: number
	characterEnd: number
	isCursor: boolean
}

export function displayPathForCwd(cwd: string | undefined, path: string): string {
	if (!cwd) return path
	const rel = relative(cwd, path)
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : path
}

export function lineRangeText(lineStart: number, lineEnd: number): string {
	return lineStart === lineEnd ? String(lineStart) : `${lineStart}-${lineEnd}`
}

function selectionLineRange(selection: IdeEventParams): SelectionLineRange | undefined {
	const range = rangedSpan(selection)?.range
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

export function selectionSnapshotFromEvent(selection: IdeEventParams): SelectionSnapshot | undefined {
	if (!selection.file) return undefined
	const range = selectionLineRange(selection)
	const span = rangedSpan(selection)
	if (!range) return undefined

	const snapshot: SelectionSnapshot = {
		filePath: selection.file,
		lineStart: range.lineStart,
		lineEnd: range.lineEnd,
		characterStart: range.characterStart,
		characterEnd: range.characterEnd,
		isCursor: range.isCursor
	}
	if (span?.text && span.text.totalCharacters > 0) snapshot.text = span.text
	return snapshot
}

function parseTextExcerpt(value: unknown): IdeTextExcerpt | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
	const record = value as {
		head?: unknown
		tail?: unknown
		totalCharacters?: unknown
		totalLines?: unknown
		headTruncated?: unknown
		tailTruncated?: unknown
	}
	if (typeof record.head !== "string") return undefined
	if (typeof record.tail !== "string" && record.tail !== undefined) return undefined
	if (!Number.isInteger(record.totalCharacters) || (record.totalCharacters as number) < 0) return undefined
	if ((!Number.isInteger(record.totalLines) || (record.totalLines as number) < 0) && record.totalLines !== undefined) return undefined
	if (typeof record.headTruncated !== "boolean" && record.headTruncated !== undefined) return undefined
	if (typeof record.tailTruncated !== "boolean" && record.tailTruncated !== undefined) return undefined
	return {
		head: record.head,
		...(record.tail !== undefined ? { tail: record.tail } : {}),
		totalCharacters: record.totalCharacters as number,
		...(record.totalLines !== undefined ? { totalLines: record.totalLines as number } : {}),
		...(record.headTruncated !== undefined ? { headTruncated: record.headTruncated } : {}),
		...(record.tailTruncated !== undefined ? { tailTruncated: record.tailTruncated } : {})
	}
}

export function parseSelectionSnapshot(value: unknown): SelectionSnapshot | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
	const record = value as {
		filePath?: unknown
		lineStart?: unknown
		lineEnd?: unknown
		characterStart?: unknown
		characterEnd?: unknown
		isCursor?: unknown
		text?: unknown
	}
	if (typeof record.filePath !== "string") return undefined
	if (!Number.isInteger(record.lineStart) || !Number.isInteger(record.lineEnd)) return undefined
	if (!Number.isInteger(record.characterStart) || !Number.isInteger(record.characterEnd)) return undefined
	if (typeof record.isCursor !== "boolean") return undefined
	const text = record.text === undefined ? undefined : parseTextExcerpt(record.text)
	if (text === undefined && record.text !== undefined) return undefined
	return {
		filePath: record.filePath,
		lineStart: record.lineStart as number,
		lineEnd: record.lineEnd as number,
		characterStart: record.characterStart as number,
		characterEnd: record.characterEnd as number,
		isCursor: record.isCursor,
		...(text !== undefined ? { text } : {})
	}
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

export function formatSnapshotContext(
	snapshot: SelectionSnapshot,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit = DEFAULT_SELECTED_TEXT_LINE_LIMIT,
	tag = "selection",
	extraAttributes = ""
): string {
	const file = displayPath(snapshot.filePath)
	const attributes = `file="${file}"${extraAttributes}`
	if (snapshot.isCursor) return `<${tag} ${attributes} position="${snapshot.lineStart}:${snapshot.characterStart}" />`

	const range = `${snapshot.lineStart}:${snapshot.characterStart}-${snapshot.lineEnd}:${snapshot.characterEnd}`
	const text =
		snapshot.text !== undefined
			? formatSelectedText(snapshot.text, snapshot.lineEnd - snapshot.lineStart + 1, selectedTextLineLimit)
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
	#current: IdeEventParams | null = null

	constructor(private readonly displayPath: (path: string) => string) {}

	setCurrent(selection: IdeEventParams): void {
		this.#current = selection.file && selectionLineRange(selection) ? selection : null
	}

	clearCurrent(): void {
		this.#current = null
	}

	snapshotCurrent(): SelectionSnapshot | null {
		return this.#current ? (selectionSnapshotFromEvent(this.#current) ?? null) : null
	}

	describeCurrent(): string | undefined {
		if (!this.#current?.file) return undefined
		const range = selectionLineRange(this.#current)
		if (!range) return undefined
		if (range.isCursor) return `${this.displayPath(this.#current.file)}#${range.lineStart}:${range.characterStart}`
		return `${this.displayPath(this.#current.file)}#${range.lineStart}:${range.characterStart}-${range.lineEnd}:${range.characterEnd}`
	}
}
