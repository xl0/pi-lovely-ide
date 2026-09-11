import { describe, expect, test } from "bun:test"
import { selectionSnapshotFromEvent } from "../../../extensions/lovely-ide/selection.js"
import { inclusiveRangeForBounds, orderedBounds, textEndForBounds } from "../src/ranges.ts"

const lines = ["alpha", "bravo", "charlie"]
const getLine = (line: number) => lines[line] ?? ""

describe("Obsidian selection range mapping", () => {
	test.each(["alpha", ""])("preserves a newline-only selection after %j", line => {
		const getLine = (index: number) => (index === 0 ? line : "next")
		const { from, to } = orderedBounds({ line: 1, ch: 0 }, { line: 0, ch: line.length })
		const range = inclusiveRangeForBounds(getLine, from, to)
		const textEnd = textEndForBounds(getLine, from, to)
		const offset = (pos: { line: number; ch: number }) => (pos.line === 0 ? pos.ch : line.length + 1 + pos.ch)
		const selectedText = `${line}\nnext`.slice(offset(from), offset(textEnd))
		expect(selectedText).toBe("\n")
		expect(range).toEqual({
			start: { line: 0, character: line.length },
			end: { line: 0, character: line.length }
		})
		const snapshot = selectionSnapshotFromEvent({
			type: "selection",
			file: "/vault/note.md",
			spans: [{ range, text: { head: selectedText, totalCharacters: selectedText.length } }]
		})
		expect(snapshot?.range?.isCursor).toBe(false)
	})

	test("one selected character is not mistaken for a cursor by the Pi client", () => {
		const range = inclusiveRangeForBounds(getLine, { line: 0, ch: 1 }, { line: 0, ch: 2 })
		const snapshot = selectionSnapshotFromEvent({
			type: "selection",
			file: "/vault/note.md",
			spans: [{ range, text: { head: "l", totalCharacters: 1 } }]
		})
		expect(snapshot?.range?.isCursor).toBe(false)
		expect(snapshot?.text?.head).toBe("l")
	})

	test("maps half-open same-line selection to inclusive protocol range", () => {
		const { from, to } = orderedBounds({ line: 0, ch: 1 }, { line: 0, ch: 4 })
		expect(inclusiveRangeForBounds(getLine, from, to)).toEqual({
			start: { line: 0, character: 1 },
			end: { line: 0, character: 3 }
		})
		expect(textEndForBounds(getLine, from, to)).toEqual({ line: 0, ch: 4 })
	})

	test("excludes trailing newline when selection ends at next line column zero", () => {
		const { from, to } = orderedBounds({ line: 0, ch: 0 }, { line: 1, ch: 0 })
		expect(inclusiveRangeForBounds(getLine, from, to)).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 0, character: 4 }
		})
		expect(textEndForBounds(getLine, from, to)).toEqual({ line: 0, ch: 5 })
	})
})
