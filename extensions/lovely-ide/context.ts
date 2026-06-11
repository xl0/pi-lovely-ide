import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"
import { formatMentionContext, MentionSnapshotSchema } from "./mention.js"
import { appendContextToContent, formatSelectionContext, type SelectedTextLineLimit, SelectionSnapshotSchema } from "./selection.js"

export const IDE_CONTEXT_CUSTOM_TYPE = "lovely-ide.context"

export const IdeContextDetailsSchema = Type.Object(
	{
		mentions: Type.Array(MentionSnapshotSchema),
		selection: Type.Union([SelectionSnapshotSchema, Type.Null()])
	},
	{ additionalProperties: true }
)
export type IdeContextDetails = Static<typeof IdeContextDetailsSchema>

const IdeContextDetailsValidator = Compile(IdeContextDetailsSchema)

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>
type ContextCustomMessage = Extract<ContextMessage, { role: "custom" }>

export function validateIdeContextDetails(value: unknown): IdeContextDetails | undefined {
	return IdeContextDetailsValidator.Check(value) ? value : undefined
}

function isIdeContextMessage(message: ContextMessage | undefined): message is ContextCustomMessage {
	return message?.role === "custom" && message.customType === IDE_CONTEXT_CUSTOM_TYPE
}

function contentIncludesRef(content: ContextUserMessage["content"], ref: string): boolean {
	if (typeof content === "string") return content.includes(ref)
	return content.some(
		part => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" && part.text.includes(ref)
	)
}

export function formatIdeContextDetails(
	details: IdeContextDetails,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit
): string {
	if (details.mentions.length) return formatMentionContext(details.mentions, displayPath, selectedTextLineLimit)
	return details.selection ? formatSelectionContext(details.selection, displayPath, selectedTextLineLimit) : ""
}

export function injectIdeContexts(
	messages: ContextEvent["messages"],
	selectionContextEnabled: boolean,
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit
): ContextEvent["messages"] | undefined {
	let lastSelectionMarkerIndex = -1
	const markers = new Map<number, IdeContextDetails>()
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!isIdeContextMessage(message)) continue
		const details = validateIdeContextDetails(message.details)
		if (!details) continue
		markers.set(i, details)
		if (details.selection) lastSelectionMarkerIndex = i
	}

	let changed = false
	const patched: ContextEvent["messages"] = []
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message) continue
		if (isIdeContextMessage(message)) {
			changed = true
			const details = markers.get(i)
			if (details) {
				for (let j = patched.length - 1; j >= 0; j--) {
					const target = patched[j]
					if (target?.role !== "user") continue
					let content = target.content
					const mentions = details.mentions.filter(mention => contentIncludesRef(content, mention.ref))
					if (mentions.length) {
						content = appendContextToContent(content, formatMentionContext(mentions, displayPath, selectedTextLineLimit))
					}
					if (mentions.length === 0 && selectionContextEnabled && i === lastSelectionMarkerIndex && details.selection) {
						content = appendContextToContent(content, formatSelectionContext(details.selection, displayPath, selectedTextLineLimit))
					}
					if (content !== target.content) patched[j] = { ...target, content }
					break
				}
			}
			continue
		}
		patched.push(message)
	}
	return changed ? patched : undefined
}
