import * as v from "valibot"

export const PI_IDE_PROTOCOL = "pi-ide"
export const PI_IDE_PROTOCOL_VERSION = 1
export const PI_IDE_AUTH_HEADER = "X-Pi-Ide-Authorization"

const nonNegInt = v.pipe(v.number(), v.integer(), v.minValue(0))
const posInt = v.pipe(v.number(), v.integer(), v.minValue(1))

const JsonRpcIdSchema = v.union([v.string(), v.number()])
type JsonRpcId = v.InferOutput<typeof JsonRpcIdSchema>

const JsonRpcMessageSchema = v.looseObject({
	jsonrpc: v.optional(v.literal("2.0")),
	id: v.optional(JsonRpcIdSchema),
	method: v.optional(v.string()),
	params: v.optional(v.unknown()),
	result: v.optional(v.unknown()),
	error: v.optional(v.unknown())
})
export type JsonRpcMessage = v.InferOutput<typeof JsonRpcMessageSchema>

const IdeLockFileSchema = v.looseObject({
	protocol: v.literal(PI_IDE_PROTOCOL),
	version: v.literal(PI_IDE_PROTOCOL_VERSION),
	port: v.pipe(posInt, v.maxValue(65535)),
	pid: v.optional(posInt),
	workspaces: v.array(v.string()),
	ide: v.optional(v.string()),
	token: v.pipe(v.string(), v.minLength(1))
})
export type IdeLockFile = v.InferOutput<typeof IdeLockFileSchema>

const PositionSchema = v.looseObject({
	line: nonNegInt,
	character: nonNegInt
})

const RangeSchema = v.looseObject({
	start: PositionSchema,
	end: PositionSchema
})

const LineRangeSchema = v.looseObject({
	start: nonNegInt,
	end: nonNegInt
})

export const CellAddressSchema = v.pipe(
	v.looseObject({
		index: v.optional(nonNegInt),
		id: v.optional(v.string())
	}),
	v.check(cell => cell.index !== undefined || cell.id !== undefined, "Cell address requires index or id")
)

export const TextExcerptSchema = v.looseObject({
	head: v.string(),
	tail: v.optional(v.string()),
	totalCharacters: nonNegInt,
	totalLines: v.optional(nonNegInt),
	headTruncated: v.optional(v.boolean()),
	tailTruncated: v.optional(v.boolean())
})
export type IdeTextExcerpt = v.InferOutput<typeof TextExcerptSchema>

const SelectedLineRangeSchema = v.intersect([LineRangeSchema, v.looseObject({ text: TextExcerptSchema })])
export type IdeSelectedLineRange = v.InferOutput<typeof SelectedLineRangeSchema>

const SpanSchema = v.looseObject({
	cell: v.optional(CellAddressSchema),
	range: v.optional(RangeSchema),
	text: v.optional(TextExcerptSchema)
})
export type IdeSpan = v.InferOutput<typeof SpanSchema>

const LocationEventParamsSchema = v.looseObject({
	type: v.picklist(["selection", "mention"]),
	file: v.nullable(v.string()),
	spans: v.array(SpanSchema)
})
export type IdeLocationEventParams = v.InferOutput<typeof LocationEventParamsSchema>

const HelloParamsSchema = v.looseObject({
	version: v.literal(PI_IDE_PROTOCOL_VERSION),
	client: v.looseObject({
		name: v.string(),
		version: v.optional(v.string()),
		pid: posInt,
		mode: v.optional(v.string())
	}),
	session: v.looseObject({
		id: v.string(),
		name: v.optional(v.string())
	}),
	connection: v.looseObject({
		id: v.string(),
		subscriptions: v.optional(v.array(v.string()))
	}),
	workspace: v.string()
})
export type HelloParams = v.InferOutput<typeof HelloParamsSchema>

export const HelloResultSchema = v.looseObject({
	version: v.literal(PI_IDE_PROTOCOL_VERSION),
	ide: v.optional(
		v.looseObject({
			name: v.string(),
			version: v.optional(v.string())
		})
	)
})

const DiagnosticSchema = v.looseObject({
	message: v.string(),
	severity: v.picklist(["Error", "Warning", "Information", "Hint"]),
	range: RangeSchema,
	source: v.optional(v.string()),
	code: v.optional(v.string())
})
export type IdeDiagnostic = v.InferOutput<typeof DiagnosticSchema>

const DiagnosticsDocumentSchema = v.looseObject({
	uri: v.string(),
	file: v.optional(v.string()),
	cell: v.optional(CellAddressSchema),
	diagnostics: v.array(DiagnosticSchema)
})
export type IdeDiagnosticsDocument = v.InferOutput<typeof DiagnosticsDocumentSchema>

const DiagnosticsEventFields = {
	type: v.literal("diagnostics"),
	documents: v.array(DiagnosticsDocumentSchema)
}

const DiagnosticsEventParamsSchema = v.variant("scope", [
	v.looseObject({
		...DiagnosticsEventFields,
		scope: v.literal("selection"),
		file: v.string(),
		cell: v.optional(CellAddressSchema),
		selectionLines: v.pipe(v.array(SelectedLineRangeSchema), v.minLength(1))
	}),
	v.looseObject({
		...DiagnosticsEventFields,
		scope: v.literal("file"),
		file: v.string(),
		cell: v.optional(CellAddressSchema)
	}),
	v.looseObject({
		...DiagnosticsEventFields,
		scope: v.literal("workspace"),
		file: v.null()
	})
])
export type IdeDiagnosticsEventParams = v.InferOutput<typeof DiagnosticsEventParamsSchema>

const EventParamsSchema = v.union([LocationEventParamsSchema, DiagnosticsEventParamsSchema])
export type IdeEventParams = v.InferOutput<typeof EventParamsSchema>

const SessionInfoChangedParamsSchema = v.looseObject({
	name: v.optional(v.string())
})
type SessionInfoChangedParams = v.InferOutput<typeof SessionInfoChangedParamsSchema>

export type ParsedIdeMessage =
	| { kind: "event"; type: IdeEventParams["type"]; params: IdeEventParams; message: JsonRpcMessage }
	| { kind: "hello"; id: JsonRpcId; params: HelloParams; message: JsonRpcMessage }
	| { kind: "ping"; id: JsonRpcId; message: JsonRpcMessage }
	| { kind: "session_info_changed"; params: SessionInfoChangedParams; message: JsonRpcMessage }
	| { kind: "jsonrpc"; message: JsonRpcMessage }

export function parseJsonRpcMessage(raw: string): JsonRpcMessage | undefined {
	try {
		return v.parse(JsonRpcMessageSchema, JSON.parse(raw))
	} catch {
		return undefined
	}
}

export function parseIdeJsonRpcMessage(message: JsonRpcMessage): ParsedIdeMessage {
	if (message.method === "event" && message.id == null) {
		const params = parseIdeEventParams(message.params)
		if (params) return { kind: "event", type: params.type, params, message }
	}

	if (message.method === "hello" && message.id != null && v.is(HelloParamsSchema, message.params)) {
		return { kind: "hello", id: message.id, params: message.params, message }
	}

	if (message.method === "ping" && message.id != null) {
		return { kind: "ping", id: message.id, message }
	}

	if (message.method === "session_info_changed" && message.id == null) {
		const params = message.params ?? {}
		if (v.is(SessionInfoChangedParamsSchema, params)) return { kind: "session_info_changed", params, message }
	}

	return { kind: "jsonrpc", message }
}

export function parseIdeMessage(raw: string): ParsedIdeMessage | undefined {
	const message = parseJsonRpcMessage(raw)
	return message ? parseIdeJsonRpcMessage(message) : undefined
}

export function parseIdeLockFile(raw: string): IdeLockFile | undefined {
	try {
		return v.parse(IdeLockFileSchema, JSON.parse(raw))
	} catch {
		return undefined
	}
}

function parseIdeEventParams(value: unknown): IdeEventParams | undefined {
	let params: IdeEventParams
	try {
		params = v.parse(EventParamsSchema, value)
	} catch {
		return undefined
	}
	if (params.type === "diagnostics") {
		if (params.scope === "selection" && params.selectionLines.some(range => range.end < range.start)) return undefined
		return params
	}
	if (params.file === null) return params.spans.length === 0 ? params : undefined
	for (const span of params.spans) {
		if (!span.range && !span.cell) return undefined
	}
	return params
}
