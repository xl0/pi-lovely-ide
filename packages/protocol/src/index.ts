import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"

export const PI_IDE_PROTOCOL = "pi-ide"
export const PI_IDE_PROTOCOL_VERSION = 1
export const PI_IDE_AUTH_HEADER = "X-Pi-Ide-Authorization"

export type IdeMethod = "hello" | "event" | "ping"
export type IdeEventType = "selection" | "mention"

export const JsonRpcIdSchema = Type.Union([Type.String(), Type.Number()])
export type JsonRpcId = Static<typeof JsonRpcIdSchema>

export const JsonRpcMessageSchema = Type.Object(
	{
		jsonrpc: Type.Optional(Type.Literal("2.0")),
		id: Type.Optional(JsonRpcIdSchema),
		method: Type.Optional(Type.String()),
		params: Type.Optional(Type.Unknown()),
		result: Type.Optional(Type.Unknown()),
		error: Type.Optional(Type.Unknown())
	},
	{ additionalProperties: true }
)
export type JsonRpcMessage = Static<typeof JsonRpcMessageSchema>
export const JsonRpcMessageValidator = Compile(JsonRpcMessageSchema)

export const IdeLockFileSchema = Type.Object(
	{
		protocol: Type.Literal(PI_IDE_PROTOCOL),
		version: Type.Literal(PI_IDE_PROTOCOL_VERSION),
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
		pid: Type.Optional(Type.Integer({ minimum: 1 })),
		workspaces: Type.Array(Type.String()),
		ide: Type.Optional(Type.String()),
		token: Type.String({ minLength: 1 })
	},
	{ additionalProperties: true }
)
export type IdeLockFile = Static<typeof IdeLockFileSchema>
export const IdeLockFileValidator = Compile(IdeLockFileSchema)

export const PositionSchema = Type.Object(
	{
		line: Type.Integer({ minimum: 0 }),
		character: Type.Integer({ minimum: 0 })
	},
	{ additionalProperties: true }
)
export type IdePosition = Static<typeof PositionSchema>

export const RangeSchema = Type.Object(
	{
		start: PositionSchema,
		end: PositionSchema
	},
	{ additionalProperties: true }
)
export type IdeRange = Static<typeof RangeSchema>

export const CellAddressSchema = Type.Object(
	{
		index: Type.Optional(Type.Integer({ minimum: 0 })),
		id: Type.Optional(Type.String())
	},
	{ additionalProperties: true }
)
export type NotebookCellAddress = Static<typeof CellAddressSchema>

export const TextExcerptSchema = Type.Object(
	{
		head: Type.String(),
		tail: Type.Optional(Type.String()),
		totalCharacters: Type.Integer({ minimum: 0 }),
		totalLines: Type.Optional(Type.Integer({ minimum: 0 })),
		headTruncated: Type.Optional(Type.Boolean()),
		tailTruncated: Type.Optional(Type.Boolean())
	},
	{ additionalProperties: true }
)
export type IdeTextExcerpt = Static<typeof TextExcerptSchema>

export const SpanSchema = Type.Object(
	{
		cell: Type.Optional(CellAddressSchema),
		range: Type.Optional(RangeSchema),
		text: Type.Optional(TextExcerptSchema)
	},
	{ additionalProperties: true }
)
export type IdeSpan = Static<typeof SpanSchema>

export const EventParamsSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("selection"), Type.Literal("mention")]),
		file: Type.Union([Type.String(), Type.Null()]),
		spans: Type.Array(SpanSchema)
	},
	{ additionalProperties: true }
)
export type IdeEventParams = Static<typeof EventParamsSchema>
export const EventParamsValidator = Compile(EventParamsSchema)

export const HelloParamsSchema = Type.Object(
	{
		version: Type.Literal(PI_IDE_PROTOCOL_VERSION),
		client: Type.Object(
			{
				name: Type.String(),
				version: Type.Optional(Type.String()),
				pid: Type.Integer({ minimum: 1 }),
				mode: Type.Optional(Type.String())
			},
			{ additionalProperties: true }
		),
		session: Type.Object(
			{
				id: Type.String(),
				name: Type.Optional(Type.String())
			},
			{ additionalProperties: true }
		),
		connection: Type.Object(
			{
				id: Type.String(),
				subscriptions: Type.Optional(Type.Array(Type.String()))
			},
			{ additionalProperties: true }
		),
		workspace: Type.String()
	},
	{ additionalProperties: true }
)
export type HelloParams = Static<typeof HelloParamsSchema>
export const HelloParamsValidator = Compile(HelloParamsSchema)

export const HelloResultSchema = Type.Object(
	{
		version: Type.Literal(PI_IDE_PROTOCOL_VERSION),
		ide: Type.Optional(
			Type.Object(
				{
					name: Type.String(),
					version: Type.Optional(Type.String())
				},
				{ additionalProperties: true }
			)
		)
	},
	{ additionalProperties: true }
)
export type HelloResult = Static<typeof HelloResultSchema>
export const HelloResultValidator = Compile(HelloResultSchema)

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

export interface ParsedIdeJsonRpcMessage {
	kind: "jsonrpc"
	message: JsonRpcMessage
}

export type ParsedIdeMessage = ParsedIdeEventMessage | ParsedIdeHelloMessage | ParsedIdePingMessage | ParsedIdeJsonRpcMessage

export function parseJsonRpcMessage(raw: string): JsonRpcMessage | undefined {
	try {
		return JsonRpcMessageValidator.Parse(JSON.parse(raw))
	} catch {
		return undefined
	}
}

export function parseIdeJsonRpcMessage(message: JsonRpcMessage): ParsedIdeMessage {
	if (message.method === "event" && message.id == null) {
		const params = parseIdeEventParams(message.params)
		if (params) return { kind: "event", type: params.type, params, message }
	}

	if (message.method === "hello" && message.id != null && HelloParamsValidator.Check(message.params)) {
		return { kind: "hello", id: message.id, params: message.params, message }
	}

	if (message.method === "ping" && message.id != null) {
		return { kind: "ping", id: message.id, message }
	}

	return { kind: "jsonrpc", message }
}

export function parseIdeMessage(raw: string): ParsedIdeMessage | undefined {
	const message = parseJsonRpcMessage(raw)
	return message ? parseIdeJsonRpcMessage(message) : undefined
}

export function parseIdeLockFile(raw: string): IdeLockFile | undefined {
	try {
		return IdeLockFileValidator.Parse(JSON.parse(raw))
	} catch {
		return undefined
	}
}

export function parseIdeEventParams(value: unknown): IdeEventParams | undefined {
	let params: IdeEventParams
	try {
		params = EventParamsValidator.Parse(value)
	} catch {
		return undefined
	}
	for (const span of params.spans) {
		if (!span.range && !span.cell) return undefined
	}
	return params
}
