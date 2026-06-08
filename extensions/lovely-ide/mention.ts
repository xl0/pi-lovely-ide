import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"
import { lineRangeText } from "./selection.js"

export const AtMentionSchema = Type.Object(
	{
		filePath: Type.String(),
		lineStart: Type.Optional(Type.Integer({ minimum: 0 })),
		lineEnd: Type.Optional(Type.Integer({ minimum: 0 }))
	},
	{ additionalProperties: true }
)

export type AtMention = Static<typeof AtMentionSchema>

const AtMentionValidator = Compile(AtMentionSchema)

export function parseAtMention(value: unknown): AtMention | undefined {
	return AtMentionValidator.Check(value) ? value : undefined
}

export function formatAtMention(mention: AtMention, displayPath: (path: string) => string): string {
	let ref = `@${displayPath(mention.filePath)}`
	if (typeof mention.lineStart === "number" && typeof mention.lineEnd === "number") {
		ref += `#${lineRangeText(mention.lineStart + 1, mention.lineEnd + 1)}`
	}
	return ref
}
