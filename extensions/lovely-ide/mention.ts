import type { IdeEventParams } from "../../packages/protocol/src/index.js"
import { formatSnapshotContext, type SelectedTextLineLimit, type SelectionSnapshot, selectionSnapshotFromEvent } from "./selection.js"

export interface MentionSnapshot {
	ref: string
	snapshot: SelectionSnapshot
}

export function formatAtMention(event: IdeEventParams, displayPath: (path: string) => string): string | undefined {
	if (!event.file) return undefined
	let ref = `@${displayPath(event.file)}`
	const span = event.spans.find(s => s.range)
	if (!span?.range) return ref

	if (span.range.end.line >= span.range.start.line) {
		const startLine = span.range.start.line + 1
		const endLine = span.range.end.line + 1
		const startCharacter = span.range.start.character + 1
		const endCharacter = span.range.end.character + 1
		ref += `#${startLine}:${startCharacter}-${endLine}:${endCharacter}`
	}
	return ref
}

export function mentionSnapshotFromEvent(event: IdeEventParams, displayPath: (path: string) => string): MentionSnapshot | undefined {
	const ref = formatAtMention(event, displayPath)
	const snapshot = selectionSnapshotFromEvent(event)
	return ref && snapshot ? { ref, snapshot } : undefined
}

function hasRefBoundary(text: string, index: number, ref: string): boolean {
	const before = index > 0 ? text[index - 1] : undefined
	const after = text[index + ref.length]
	const beforeOk = before === undefined || /\s/.test(before) || "([{'\"`".includes(before)
	const afterOk = after === undefined || /\s/.test(after) || ".,;:!?)]}'\"`".includes(after)
	return beforeOk && afterOk
}

function countRefOccurrences(text: string, ref: string): number {
	let count = 0
	let offset = 0
	while (offset < text.length) {
		const index = text.indexOf(ref, offset)
		if (index === -1) break
		if (hasRefBoundary(text, index, ref)) count++
		offset = index + ref.length
	}
	return count
}

export function mentionsReferencedInPrompt(mentions: MentionSnapshot[], prompt: string): MentionSnapshot[] {
	const counts = new Map<string, number>()
	const used = new Map<string, number>()
	return mentions.filter(mention => {
		let count = counts.get(mention.ref)
		if (count === undefined) {
			count = countRefOccurrences(prompt, mention.ref)
			counts.set(mention.ref, count)
		}
		const usedCount = used.get(mention.ref) ?? 0
		if (usedCount >= count) return false
		used.set(mention.ref, usedCount + 1)
		return true
	})
}

export function formatMentionContext(
	mentions: MentionSnapshot[],
	displayPath: (path: string) => string,
	selectedTextLineLimit: SelectedTextLineLimit
): string {
	return mentions
		.map(mention => formatSnapshotContext(mention.snapshot, displayPath, selectedTextLineLimit, "mention", ` ref="${mention.ref}"`))
		.join("\n")
}
