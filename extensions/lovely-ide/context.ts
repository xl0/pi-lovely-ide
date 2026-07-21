import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import * as v from "valibot"
import { DiagnosticsSnapshotSchema, formatDiagnosticsContext } from "./diagnostics.js"
import { formatMentionContext, MentionSnapshotSchema } from "./mention.js"
import { appendContextToContent, formatSelectionContext, type SelectedTextLineLimit, SelectionSnapshotSchema } from "./selection.js"

export const IDE_CONTEXT_CUSTOM_TYPE = "lovely-ide.context"

export const IdeContextDetailsSchema = v.looseObject({
	mentions: v.array(MentionSnapshotSchema),
	diagnostics: v.optional(v.array(DiagnosticsSnapshotSchema)),
	selection: v.nullable(SelectionSnapshotSchema)
})
export type IdeContextDetails = v.InferOutput<typeof IdeContextDetailsSchema>

type ContextMessage = ContextEvent["messages"][number]
type ContextUserMessage = Extract<ContextMessage, { role: "user" }>
type ContextCustomMessage = Extract<ContextMessage, { role: "custom" }>

export function validateIdeContextDetails(value: unknown): IdeContextDetails | undefined {
	const result = v.safeParse(IdeContextDetailsSchema, value)
	return result.success ? result.output : undefined
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
	const explicit = []
	if (details.mentions.length) explicit.push(formatMentionContext(details.mentions, displayPath, selectedTextLineLimit))
	if (details.diagnostics?.length) explicit.push(formatDiagnosticsContext(details.diagnostics, selectedTextLineLimit))
	const hasExplicitSelection = details.mentions.length > 0 || details.diagnostics?.some(snapshot => snapshot.scope === "selection")
	if (!hasExplicitSelection && details.selection) {
		explicit.push(formatSelectionContext(details.selection, displayPath, selectedTextLineLimit))
	}
	return explicit.join("\n")
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
	const diagnosticsContexts = []
	let diagnosticsTargetIndex = -1
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
					const diagnostics = (details.diagnostics ?? []).filter(snapshot => contentIncludesRef(content, snapshot.ref))
					if (mentions.length) content = appendContextToContent(content, formatMentionContext(mentions, displayPath, selectedTextLineLimit))
					if (diagnostics.length) {
						diagnosticsContexts.push(...diagnostics)
						diagnosticsTargetIndex = j
					}
					const hasExplicitSelection = mentions.length > 0 || diagnostics.some(snapshot => snapshot.scope === "selection")
					if (!hasExplicitSelection && selectionContextEnabled && i === lastSelectionMarkerIndex && details.selection) {
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
	if (diagnosticsContexts.length && diagnosticsTargetIndex >= 0) {
		const target = patched[diagnosticsTargetIndex]
		if (target?.role === "user") {
			patched[diagnosticsTargetIndex] = {
				...target,
				content: appendContextToContent(target.content, formatDiagnosticsContext(diagnosticsContexts, selectedTextLineLimit))
			}
		}
	}
	return changed ? patched : undefined
}
