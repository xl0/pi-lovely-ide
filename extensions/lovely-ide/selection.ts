import { relative } from "node:path"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import type { IdeEventParams, IdeSpan } from "../../packages/protocol/src/index.js"

export const SELECTED_TEXT_LINE_LIMITS = [0, 3, 5, 9] as const
export type SelectedTextLineLimit = (typeof SELECTED_TEXT_LINE_LIMITS)[number]
export const DEFAULT_SELECTED_TEXT_LINE_LIMIT: SelectedTextLineLimit = 3
export const SELECTION_CONTEXT_CUSTOM_TYPE = "lovely-ide.selection"

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
	text?: string
	textTotalCharacters?: number
}

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>
type ContextCustomMessage = Extract<ContextMessage, { role: "custom" }>

interface SelectionLineRange {
	lineStart: number
	lineEnd: number
	lineCount: number
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
		lineCount: lineEnd - lineStart + 1,
		characterStart: range.start.character + 1,
		characterEnd: range.end.character + 1,
		isCursor
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
		textTotalCharacters?: unknown
	}
	if (typeof record.filePath !== "string") return undefined
	if (!Number.isInteger(record.lineStart) || !Number.isInteger(record.lineEnd)) return undefined
	if (!Number.isInteger(record.characterStart) || !Number.isInteger(record.characterEnd)) return undefined
	if (typeof record.isCursor !== "boolean") return undefined
	if (typeof record.text !== "string" && record.text !== undefined) return undefined
	if (!Number.isInteger(record.textTotalCharacters) && record.textTotalCharacters !== undefined) return undefined
	return {
		filePath: record.filePath,
		lineStart: record.lineStart as number,
		lineEnd: record.lineEnd as number,
		characterStart: record.characterStart as number,
		characterEnd: record.characterEnd as number,
		isCursor: record.isCursor,
		...(record.text !== undefined ? { text: record.text } : {}),
		...(record.textTotalCharacters !== undefined ? { textTotalCharacters: record.textTotalCharacters as number } : {})
	}
}

function isSelectionContextMessage(message: ContextMessage | undefined): message is ContextCustomMessage {
	return message?.role === "custom" && message.customType === SELECTION_CONTEXT_CUSTOM_TYPE
}

function appendContextToContent(content: ContextUserMessage["content"], context: string): ContextUserMessage["content"] {
	const suffix = `\n\n${context}`
	if (typeof content === "string") return `${content}${suffix}`
	return [...content, { type: "text", text: suffix }]
}

function formatSelectedText(
	text: string,
	totalLineCount: number,
	textTotalCharacters: number | undefined,
	lineLimit: SelectedTextLineLimit
): string | undefined {
	if (lineLimit === 0 || text.length === 0) return undefined
	const senderTruncated = textTotalCharacters !== undefined && text.length < textTotalCharacters
	const lines = text.split(/\r?\n/)
	if (!senderTruncated && lines.length <= lineLimit) return text

	if (senderTruncated) {
		const shownLines = lines.slice(0, lineLimit)
		const skipped = Math.max(0, totalLineCount - shownLines.length)
		return [...shownLines, `[${skipped} more lines]`].join("\n")
	}

	const edgeLines = Math.floor(lineLimit / 2)
	const skipped = Math.max(0, totalLineCount - edgeLines * 2)
	return [...lines.slice(0, edgeLines), `[${skipped} more lines]`, ...lines.slice(-edgeLines)].join("\n")
}

export function formatSelectionContext(
	snapshot: SelectionSnapshot,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit = DEFAULT_SELECTED_TEXT_LINE_LIMIT
): string {
	const file = displayPath(snapshot.filePath)
	if (snapshot.isCursor) return `<cursor file="${file}" position="${snapshot.lineStart}:${snapshot.characterStart}" />`

	const range = `${snapshot.lineStart}:${snapshot.characterStart}-${snapshot.lineEnd}:${snapshot.characterEnd}`
	const text =
		snapshot.text !== undefined
			? formatSelectedText(snapshot.text, snapshot.lineEnd - snapshot.lineStart + 1, snapshot.textTotalCharacters, selectedTextLineLimit)
			: undefined
	if (text !== undefined) {
		return `<selection file="${file}" range="${range}">\n${text}\n</selection>`
	}
	return `<selection file="${file}" range="${range}" />`
}

export function injectSelectionContext(
	messages: ContextEvent["messages"],
	enabled: boolean,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit = DEFAULT_SELECTED_TEXT_LINE_LIMIT
): ContextEvent["messages"] | undefined {
	let lastMarkerIndex = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isSelectionContextMessage(messages[i])) {
			lastMarkerIndex = i
			break
		}
	}
	if (lastMarkerIndex === -1) return undefined

	const patched: ContextEvent["messages"] = []
	let targetUserIndex = -1
	let snapshot: SelectionSnapshot | undefined
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message) continue
		if (isSelectionContextMessage(message)) {
			if (enabled && i === lastMarkerIndex) {
				snapshot = parseSelectionSnapshot(message.details)
				for (let j = patched.length - 1; j >= 0; j--) {
					if (patched[j]?.role === "user") {
						targetUserIndex = j
						break
					}
				}
			}
			continue
		}
		patched.push(message)
	}

	const targetUser = patched[targetUserIndex]
	if (snapshot && targetUser?.role === "user") {
		patched[targetUserIndex] = {
			...targetUser,
			content: appendContextToContent(targetUser.content, formatSelectionContext(snapshot, displayPath, selectedTextLineLimit))
		}
	}
	return patched
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
		if (!this.#current?.file) return null
		const range = selectionLineRange(this.#current)
		const span = rangedSpan(this.#current)
		if (!range) return null

		const snapshot: SelectionSnapshot = {
			filePath: this.#current.file,
			lineStart: range.lineStart,
			lineEnd: range.lineEnd,
			characterStart: range.characterStart,
			characterEnd: range.characterEnd,
			isCursor: range.isCursor
		}
		if (typeof span?.text === "string" && span.text.length > 0) {
			snapshot.text = span.text
			const textTotalCharacters = span.textTotalCharacters
			if (Number.isInteger(textTotalCharacters)) snapshot.textTotalCharacters = textTotalCharacters as number
		}
		return snapshot
	}

	describeCurrent(): string | undefined {
		if (!this.#current?.file) return undefined
		const range = selectionLineRange(this.#current)
		if (!range) return undefined
		if (range.isCursor) return `${this.displayPath(this.#current.file)}#${range.lineStart}:${range.characterStart}`
		return `${this.displayPath(this.#current.file)}#${range.lineStart}:${range.characterStart}-${range.lineEnd}:${range.characterEnd}`
	}
}
