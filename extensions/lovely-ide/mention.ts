import type { IdeEventParams } from "../../packages/protocol/src/index.js"
import { lineRangeText } from "./selection.js"

export function formatAtMention(event: IdeEventParams, displayPath: (path: string) => string): string | undefined {
	if (!event.file) return undefined
	let ref = `@${displayPath(event.file)}`
	const span = event.spans.find(s => s.range)
	if (!span?.range) return ref

	if (span.range.end.line >= span.range.start.line) {
		ref += `#${lineRangeText(span.range.start.line + 1, span.range.end.line + 1)}`
	}
	return ref
}
