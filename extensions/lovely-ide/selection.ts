import { Buffer } from "node:buffer"
import { relative } from "node:path"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"

const MAX_SELECTED_TEXT_BYTES = 2 * 1024

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

export const AtMentionSchema = Type.Object(
	{
		filePath: Type.String(),
		lineStart: Type.Optional(Type.Integer({ minimum: 0 })),
		lineEnd: Type.Optional(Type.Integer({ minimum: 0 }))
	},
	{ additionalProperties: true }
)

export type AtMention = Static<typeof AtMentionSchema>

const AtMentionValidator = Compile(AtMentionSchema)

export function parseAtMention(value: unknown): AtMention | undefined {
	return AtMentionValidator.Check(value) ? value : undefined
}

interface SelectionSnapshot {
	filePath: string
	lineStart: number
	lineEnd: number
	text?: string
}

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

function lineRangeText(lineStart: number, lineEnd: number): string {
	return lineStart === lineEnd ? String(lineStart) : `${lineStart}-${lineEnd}`
}

export class SelectionState {
	#current: IdeSelection | null = null
	#pendingSnapshot: SelectionSnapshot | null | undefined
	#activeSnapshot: SelectionSnapshot | null = null
	#activeUserTimestamp: number | undefined
	#awaitingUserMessage = false

	constructor(private readonly displayPath: (path: string) => string) {}

	setCurrent(selection: IdeSelection): void {
		this.#current = this.isActiveSelection(selection) ? selection : null
	}

	clearCurrent(): void {
		this.#current = null
	}

	clearTurn(): void {
		this.#pendingSnapshot = undefined
		this.#activeSnapshot = null
		this.#activeUserTimestamp = undefined
		this.#awaitingUserMessage = false
	}

	clearAll(): void {
		this.clearCurrent()
		this.clearTurn()
	}

	capturePending(canUseSelection: boolean): void {
		this.#pendingSnapshot = canUseSelection ? this.snapshot() : null
	}

	startTurn(enabled: boolean): void {
		this.#activeSnapshot = enabled ? (this.#pendingSnapshot ?? null) : null
		this.#activeUserTimestamp = undefined
		this.#awaitingUserMessage = this.#activeSnapshot !== null
		this.#pendingSnapshot = undefined
	}

	handleMessageStart(message: { role?: string; timestamp?: number }): void {
		if (message.role !== "user") return
		if (this.#awaitingUserMessage) {
			this.#activeUserTimestamp = message.timestamp
			this.#awaitingUserMessage = false
			return
		}
		if (this.#activeUserTimestamp !== undefined && message.timestamp !== this.#activeUserTimestamp) {
			this.#activeSnapshot = null
			this.#activeUserTimestamp = undefined
		}
	}

	injectContext(messages: ContextEvent["messages"], enabled: boolean): ContextEvent["messages"] | undefined {
		if (!enabled || !this.#activeSnapshot || this.#activeUserTimestamp === undefined) return

		let selectionUserIndex = -1
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]
			if (message?.role === "user" && message.timestamp === this.#activeUserTimestamp) {
				selectionUserIndex = i
				break
			}
		}
		if (selectionUserIndex === -1) return

		const patched = [...messages]
		patched.splice(selectionUserIndex + 1, 0, {
			role: "user",
			content: this.formatContext(this.#activeSnapshot),
			timestamp: Date.now()
		})
		return patched
	}

	describeCurrent(): string | undefined {
		if (!this.#current?.filePath) return undefined

		const range = this.selectionLineRange(this.#current)
		if (!range) return undefined
		return `${this.displayPath(this.#current.filePath)}#${lineRangeText(range.lineStart, range.lineEnd)}`
	}

	mentionText(mention: AtMention): string {
		let ref = `@${this.displayPath(mention.filePath)}`
		if (typeof mention.lineStart === "number" && typeof mention.lineEnd === "number") {
			ref += `#${lineRangeText(mention.lineStart + 1, mention.lineEnd + 1)}`
		}
		return ref
	}

	private selectionLineRange(selection: IdeSelection): SelectionLineRange | undefined {
		const range = selection.selection
		if (!range) return undefined

		const endLineZeroBased = range.end.line - (range.end.character === 0 ? 1 : 0)
		const lineStart = range.start.line + 1
		const lineEnd = endLineZeroBased + 1
		if (lineEnd < lineStart) return undefined
		return { lineStart, lineEnd, lineCount: lineEnd - lineStart + 1 }
	}

	private isActiveSelection(selection: IdeSelection | undefined): selection is IdeSelection & { filePath: string } {
		return !!selection?.filePath && selection.selection?.isEmpty !== true && this.selectionLineRange(selection) !== undefined
	}

	private snapshot(): SelectionSnapshot | null {
		if (!this.#current?.filePath) return null
		const range = this.selectionLineRange(this.#current)
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

	private formatContext(snapshot: SelectionSnapshot): string {
		const file = this.displayPath(snapshot.filePath)
		const lines = lineRangeText(snapshot.lineStart, snapshot.lineEnd)
		if (snapshot.text !== undefined) {
			return `<ide file="${file}" lines="${lines}">\n<selected>\n${snapshot.text}\n</selected>\n</ide>`
		}
		return `<ide file="${file}" lines="${lines}"></ide>`
	}
}
