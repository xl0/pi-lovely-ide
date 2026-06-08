import { Buffer } from "node:buffer"
import { relative } from "node:path"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"

const MAX_SELECTED_TEXT_BYTES = 2 * 1024
export const SELECTION_CONTEXT_CUSTOM_TYPE = "lovely-ide.selection"

const PositionSchema = Type.Object(
	{
		line: Type.Integer({ minimum: 0 }),
		character: Type.Integer({ minimum: 0 })
	},
	{ additionalProperties: true }
)

const SelectionRangeSchema = Type.Object(
	{
		start: PositionSchema,
		end: PositionSchema,
		isEmpty: Type.Optional(Type.Boolean())
	},
	{ additionalProperties: true }
)

export const IdeSelectionSchema = Type.Object(
	{
		selection: Type.Optional(Type.Union([SelectionRangeSchema, Type.Null()])),
		text: Type.Optional(Type.String()),
		filePath: Type.Optional(Type.String())
	},
	{ additionalProperties: true }
)

export type IdeSelection = Static<typeof IdeSelectionSchema>

const IdeSelectionValidator = Compile(IdeSelectionSchema)

export function parseIdeSelection(value: unknown): IdeSelection | undefined {
	return IdeSelectionValidator.Check(value) ? value : undefined
}

export interface SelectionSnapshot {
	filePath: string
	lineStart: number
	lineEnd: number
	text?: string
}

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>
type ContextCustomMessage = Extract<ContextMessage, { role: "custom" }>

interface SelectionLineRange {
	lineStart: number
	lineEnd: number
	lineCount: number
}

export function displayPathForCwd(cwd: string | undefined, path: string): string {
	if (!cwd) return path
	const rel = relative(cwd, path)
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : path
}

export function lineRangeText(lineStart: number, lineEnd: number): string {
	return lineStart === lineEnd ? String(lineStart) : `${lineStart}-${lineEnd}`
}

function selectionLineRange(selection: IdeSelection): SelectionLineRange | undefined {
	const range = selection.selection
	if (!range) return undefined

	const endLineZeroBased = range.end.line - (range.end.character === 0 ? 1 : 0)
	const lineStart = range.start.line + 1
	const lineEnd = endLineZeroBased + 1
	if (lineEnd < lineStart) return undefined
	return { lineStart, lineEnd, lineCount: lineEnd - lineStart + 1 }
}

function parseSnapshot(value: unknown): SelectionSnapshot | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
	const record = value as { filePath?: unknown; lineStart?: unknown; lineEnd?: unknown; text?: unknown }
	if (typeof record.filePath !== "string") return undefined
	if (!Number.isInteger(record.lineStart) || !Number.isInteger(record.lineEnd)) return undefined
	if (typeof record.text !== "string" && record.text !== undefined) return undefined
	return {
		filePath: record.filePath,
		lineStart: record.lineStart as number,
		lineEnd: record.lineEnd as number,
		...(record.text !== undefined ? { text: record.text } : {})
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

function formatSelectionContext(snapshot: SelectionSnapshot, displayPath: (path: string) => string): string {
	const file = displayPath(snapshot.filePath)
	const lines = lineRangeText(snapshot.lineStart, snapshot.lineEnd)
	if (snapshot.text !== undefined) {
		return `<ide file="${file}" lines="${lines}">\n<selected>\n${snapshot.text}\n</selected>\n</ide>`
	}
	return `<ide file="${file}" lines="${lines}"></ide>`
}

export function injectSelectionContext(
	messages: ContextEvent["messages"],
	enabled: boolean,
	displayPath: (path: string) => string
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
				snapshot = parseSnapshot(message.details)
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
			content: appendContextToContent(targetUser.content, formatSelectionContext(snapshot, displayPath))
		}
	}
	return patched
}

export class SelectionState {
	#current: IdeSelection | null = null

	constructor(private readonly displayPath: (path: string) => string) {}

	setCurrent(selection: IdeSelection): void {
		this.#current = selection.filePath && selection.selection?.isEmpty !== true && selectionLineRange(selection) ? selection : null
	}

	clearCurrent(): void {
		this.#current = null
	}

	snapshotCurrent(): SelectionSnapshot | null {
		if (!this.#current?.filePath) return null
		const range = selectionLineRange(this.#current)
		if (!range) return null

		const snapshot: SelectionSnapshot = {
			filePath: this.#current.filePath,
			lineStart: range.lineStart,
			lineEnd: range.lineEnd
		}
		if (
			range.lineCount <= 2 &&
			typeof this.#current.text === "string" &&
			this.#current.text.length > 0 &&
			Buffer.byteLength(this.#current.text, "utf8") <= MAX_SELECTED_TEXT_BYTES
		) {
			snapshot.text = this.#current.text
		}
		return snapshot
	}

	describeCurrent(): string | undefined {
		if (!this.#current?.filePath) return undefined
		const range = selectionLineRange(this.#current)
		if (!range) return undefined
		return `${this.displayPath(this.#current.filePath)}#${lineRangeText(range.lineStart, range.lineEnd)}`
	}
}
