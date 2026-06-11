import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { formatMentionContext, type MentionSnapshot } from "./mention.js"
import {
	appendContextToContent,
	formatSelectionContext,
	parseSelectionSnapshot,
	type SelectedTextLineLimit,
	type SelectionSnapshot
} from "./selection.js"

export const IDE_CONTEXT_CUSTOM_TYPE = "lovely-ide.context"

export interface IdeContextDetails {
	mentions: MentionSnapshot[]
	selection: SelectionSnapshot | null
}

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>
type ContextCustomMessage = Extract<ContextMessage, { role: "custom" }>

function parseMentionSnapshot(value: unknown): MentionSnapshot | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
	const record = value as { ref?: unknown; snapshot?: unknown }
	if (typeof record.ref !== "string") return undefined
	const snapshot = parseSelectionSnapshot(record.snapshot)
	if (!snapshot) return undefined
	return { ref: record.ref, snapshot }
}

export function parseIdeContextDetails(value: unknown): IdeContextDetails | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
	const record = value as { mentions?: unknown; selection?: unknown }
	if (!Array.isArray(record.mentions)) return undefined
	const selection = record.selection === null ? null : parseSelectionSnapshot(record.selection)
	if (selection === undefined) return undefined
	return {
		mentions: record.mentions.map(parseMentionSnapshot).filter(mention => mention !== undefined),
		selection
	}
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
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (!isIdeContextMessage(message)) continue
		const details = parseIdeContextDetails(message.details)
		if (details?.selection) {
			lastSelectionMarkerIndex = i
			break
		}
	}

	let changed = false
	const patched: ContextEvent["messages"] = []
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message) continue
		if (isIdeContextMessage(message)) {
			changed = true
			const details = parseIdeContextDetails(message.details)
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
