import * as v from "valibot"

export const PI_IDE_PROTOCOL = "pi-ide"
export const PI_IDE_PROTOCOL_VERSION = 1
export const PI_IDE_AUTH_HEADER = "X-Pi-Ide-Authorization"

export type IdeMethod = "hello" | "event" | "ping" | "session_info_changed"
export type IdeEventType = "selection" | "mention"

export const JsonRpcIdSchema = v.union([v.string(), v.number()])
export type JsonRpcId = v.InferOutput<typeof JsonRpcIdSchema>

export const JsonRpcMessageSchema = v.looseObject({
	jsonrpc: v.optional(v.literal("2.0")),
	id: v.optional(JsonRpcIdSchema),
	method: v.optional(v.string()),
	params: v.optional(v.unknown()),
	result: v.optional(v.unknown()),
	error: v.optional(v.unknown())
})
export type JsonRpcMessage = v.InferOutput<typeof JsonRpcMessageSchema>

export const IdeLockFileSchema = v.looseObject({
	protocol: v.literal(PI_IDE_PROTOCOL),
	version: v.literal(PI_IDE_PROTOCOL_VERSION),
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
	pid: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	workspaces: v.array(v.string()),
	ide: v.optional(v.string()),
	token: v.pipe(v.string(), v.minLength(1))
})
export type IdeLockFile = v.InferOutput<typeof IdeLockFileSchema>

export const PositionSchema = v.looseObject({
	line: v.pipe(v.number(), v.integer(), v.minValue(0)),
	character: v.pipe(v.number(), v.integer(), v.minValue(0))
})
export type IdePosition = v.InferOutput<typeof PositionSchema>

export const RangeSchema = v.looseObject({
	start: PositionSchema,
	end: PositionSchema
})
export type IdeRange = v.InferOutput<typeof RangeSchema>

export const CellAddressSchema = v.looseObject({
	index: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	id: v.optional(v.string())
})
export type NotebookCellAddress = v.InferOutput<typeof CellAddressSchema>

export const TextExcerptSchema = v.looseObject({
	head: v.string(),
	tail: v.optional(v.string()),
	totalCharacters: v.pipe(v.number(), v.integer(), v.minValue(0)),
	totalLines: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	headTruncated: v.optional(v.boolean()),
	tailTruncated: v.optional(v.boolean())
})
export type IdeTextExcerpt = v.InferOutput<typeof TextExcerptSchema>

export const SpanSchema = v.looseObject({
	cell: v.optional(CellAddressSchema),
	range: v.optional(RangeSchema),
	text: v.optional(TextExcerptSchema)
})
export type IdeSpan = v.InferOutput<typeof SpanSchema>

export const EventParamsSchema = v.looseObject({
	type: v.union([v.literal("selection"), v.literal("mention")]),
	file: v.union([v.string(), v.null_()]),
	spans: v.array(SpanSchema)
})
export type IdeEventParams = v.InferOutput<typeof EventParamsSchema>

export const HelloParamsSchema = v.looseObject({
	version: v.literal(PI_IDE_PROTOCOL_VERSION),
	client: v.looseObject({
		name: v.string(),
		version: v.optional(v.string()),
		pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
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
export type HelloResult = v.InferOutput<typeof HelloResultSchema>

export const SessionInfoChangedParamsSchema = v.looseObject({
	name: v.optional(v.string())
})
export type SessionInfoChangedParams = v.InferOutput<typeof SessionInfoChangedParamsSchema>

export interface ParsedIdeEventMessage {
	kind: "event"
	type: IdeEventType
	params: IdeEventParams
	message: JsonRpcMessage
}

export interface ParsedIdeHelloMessage {
	kind: "hello"
	id: JsonRpcId
	params: HelloParams
	message: JsonRpcMessage
}

export interface ParsedIdePingMessage {
	kind: "ping"
	id: JsonRpcId
	message: JsonRpcMessage
}

export interface ParsedIdeSessionInfoChangedMessage {
	kind: "session_info_changed"
	params: SessionInfoChangedParams
	message: JsonRpcMessage
}

export interface ParsedIdeJsonRpcMessage {
	kind: "jsonrpc"
	message: JsonRpcMessage
}

export type ParsedIdeMessage =
	| ParsedIdeEventMessage
	| ParsedIdeHelloMessage
	| ParsedIdePingMessage
	| ParsedIdeSessionInfoChangedMessage
	| ParsedIdeJsonRpcMessage

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
		const params = parseSessionInfoChangedParams(message.params ?? {})
		if (params) return { kind: "session_info_changed", params, message }
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

export function parseIdeEventParams(value: unknown): IdeEventParams | undefined {
	let params: IdeEventParams
	try {
		params = v.parse(EventParamsSchema, value)
	} catch {
		return undefined
	}
	if (params.file === null) return params.spans.length === 0 ? params : undefined
	for (const span of params.spans) {
		if (!span.range && !span.cell) return undefined
	}
	return params
}

export function parseSessionInfoChangedParams(value: unknown): SessionInfoChangedParams | undefined {
	try {
		return v.parse(SessionInfoChangedParamsSchema, value)
	} catch {
		return undefined
	}
}
