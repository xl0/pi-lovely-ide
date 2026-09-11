import type { IdeSpan } from "../../../packages/protocol/src/index.js"

export interface EditorPositionLike {
	line: number
	ch: number
}

function comparePosition(a: EditorPositionLike, b: EditorPositionLike): number {
	return a.line - b.line || a.ch - b.ch
}

export function orderedBounds(a: EditorPositionLike, b: EditorPositionLike): { from: EditorPositionLike; to: EditorPositionLike } {
	return comparePosition(a, b) <= 0 ? { from: a, to: b } : { from: b, to: a }
}

export function inclusiveRangeForBounds(
	getLine: (line: number) => string,
	from: EditorPositionLike,
	to: EditorPositionLike
): NonNullable<IdeSpan["range"]> {
	if (comparePosition(from, to) === 0) {
		return {
			start: { line: from.line, character: from.ch },
			end: { line: from.line, character: from.ch }
		}
	}

	if (to.ch === 0 && to.line > from.line) {
		const endLine = to.line - 1
		return {
			start: { line: from.line, character: from.ch },
			end: { line: endLine, character: Math.max(0, getLine(endLine).length - 1) }
		}
	}

	return {
		start: { line: from.line, character: from.ch },
		end: { line: to.line, character: Math.max(0, to.ch - 1) }
	}
}

export function textEndForBounds(getLine: (line: number) => string, from: EditorPositionLike, to: EditorPositionLike): EditorPositionLike {
	if (comparePosition(from, to) === 0) return to
	if (to.ch === 0 && to.line > from.line) {
		const line = to.line - 1
		return { line, ch: getLine(line).length }
	}
	return to
}
