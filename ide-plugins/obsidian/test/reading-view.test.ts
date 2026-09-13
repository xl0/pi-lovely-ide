import { expect, test } from "bun:test"
import { validateIdeContextDetails } from "../../../extensions/lovely-ide/context.js"
import { formatMentionContext, mentionSnapshotFromEvent } from "../../../extensions/lovely-ide/mention.js"
import { formatSelectionContext, selectionSnapshotFromEvent } from "../../../extensions/lovely-ide/selection.js"
import { parseIdeMessage } from "../../../packages/protocol/src/index.js"

test("rendered text survives protocol, selection, and mention rendering without source positions", () => {
	const parsed = parseIdeMessage(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "event",
			params: {
				type: "selection",
				file: "/vault/note.md",
				spans: [],
				text: { head: "Rendered text", totalCharacters: 13, totalLines: 1 }
			}
		})
	)
	if (parsed?.kind !== "event" || parsed.params.type !== "selection") throw new Error("Invalid selection event")
	const snapshot = selectionSnapshotFromEvent(parsed.params, "Obsidian")
	if (!snapshot) throw new Error("Missing selection snapshot")
	expect(formatSelectionContext(snapshot, path => path)).toBe(
		'<selection file="/vault/note.md" ide="Obsidian">\nRendered text\n</selection>'
	)
	const mention = mentionSnapshotFromEvent({ ...parsed.params, type: "mention" }, path => path, "Obsidian")
	if (!mention) throw new Error("Missing mention snapshot")
	expect(mention.ref).toBe("@/vault/note.md")
	expect(formatMentionContext([mention], path => path, 3)).toBe(
		'<mention file="/vault/note.md" ide="Obsidian" ref="@/vault/note.md">\nRendered text\n</mention>'
	)
	const details = validateIdeContextDetails(JSON.parse(JSON.stringify({ selection: snapshot, mentions: [mention] })))
	expect(details?.selection?.ide).toBe("Obsidian")
	expect(details?.mentions[0]?.snapshot.ide).toBe("Obsidian")
})

test("file-level text cannot coexist with source spans or a missing file", () => {
	const text = { head: "Rendered text", totalCharacters: 13 }
	for (const params of [
		{ type: "selection", file: null, spans: [], text },
		{
			type: "mention",
			file: "/vault/note.md",
			spans: [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }],
			text
		},
		{ type: "selection", file: "/vault/note.md", spans: [], text: { head: "bad", totalCharacters: -1 } }
	]) {
		expect(parseIdeMessage(JSON.stringify({ method: "event", params }))?.kind).not.toBe("event")
	}
})

test("cursor context escapes the IDE name without changing stored metadata", () => {
	const ide = 'Code & "Notes" <test>'
	const snapshot = selectionSnapshotFromEvent(
		{
			type: "selection",
			file: "/vault/note.md",
			spans: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }]
		},
		ide
	)
	if (!snapshot) throw new Error("Missing cursor snapshot")
	expect(snapshot.ide).toBe(ide)
	expect(formatSelectionContext(snapshot, path => path)).toBe(
		'<cursor file="/vault/note.md" ide="Code &amp; &quot;Notes&quot; &lt;test&gt;" position="1:1" />'
	)
})
