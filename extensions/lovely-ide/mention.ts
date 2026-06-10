import type { IdeEventParams, IdeRange } from "../../packages/protocol/src/index.js"
import { lineRangeText } from "./selection.js"

function displayLineEnd(range: IdeRange): number {
	const isCursor = range.start.line === range.end.line && range.start.character === range.end.character
	return range.end.line - (!isCursor && range.end.character === 0 ? 1 : 0)
}

export function formatAtMention(event: IdeEventParams, displayPath: (path: string) => string): string | undefined {
	if (!event.file) return undefined
	let ref = `@${displayPath(event.file)}`
	const span = event.spans.find(s => s.range)
	if (!span?.range) return ref

	const lineEnd = displayLineEnd(span.range)
	if (lineEnd >= span.range.start.line) {
		ref += `#${lineRangeText(span.range.start.line + 1, lineEnd + 1)}`
	}
	return ref
}
