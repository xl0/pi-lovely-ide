import * as v from "valibot"
import type { IdeLocationEventParams } from "../../packages/protocol/src/index.js"
import {
	formatSnapshotContext,
	formatSnapshotReference,
	type SelectedTextLineLimit,
	SelectionSnapshotSchema,
	selectionSnapshotFromEvent
} from "./selection.js"

export const MentionSnapshotSchema = v.looseObject({
	ref: v.string(),
	snapshot: SelectionSnapshotSchema
})
export type MentionSnapshot = v.InferOutput<typeof MentionSnapshotSchema>

export function formatAtMention(event: IdeLocationEventParams, displayPath: (path: string) => string): string | undefined {
	const snapshot = selectionSnapshotFromEvent(event)
	if (snapshot) return formatSnapshotReference(snapshot, displayPath, { prefix: "@", collapseCursor: true })
	return event.file ? `@${displayPath(event.file)}` : undefined
}

export function mentionSnapshotFromEvent(
	event: IdeLocationEventParams,
	displayPath: (path: string) => string
): MentionSnapshot | undefined {
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

export function snapshotsReferencedInPrompt<T extends { ref: string }>(snapshots: T[], prompt: string): T[] {
	const counts = new Map<string, number>()
	const used = new Map<string, number>()
	return snapshots.filter(snapshot => {
		let count = counts.get(snapshot.ref)
		if (count === undefined) {
			count = countRefOccurrences(prompt, snapshot.ref)
			counts.set(snapshot.ref, count)
		}
		const usedCount = used.get(snapshot.ref) ?? 0
		if (usedCount >= count) return false
		used.set(snapshot.ref, usedCount + 1)
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
