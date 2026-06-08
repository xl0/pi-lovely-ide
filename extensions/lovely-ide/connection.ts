import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"
import { WebSocket } from "undici"

const CONNECT_TIMEOUT_MS = 3_000

const JsonRpcMessageSchema = Type.Object(
	{
		jsonrpc: Type.Optional(Type.String()),
		id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
		method: Type.Optional(Type.String()),
		params: Type.Optional(Type.Unknown()),
		result: Type.Optional(Type.Unknown()),
		error: Type.Optional(Type.Unknown())
	},
	{ additionalProperties: true }
)

export type JsonRpcMessage = Static<typeof JsonRpcMessageSchema>

const JsonRpcMessageValidator = Compile(JsonRpcMessageSchema)

function parseJsonRpcMessage(raw: string): JsonRpcMessage | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}
	return JsonRpcMessageValidator.Check(parsed) ? parsed : undefined
}

function openAndInitialize(socket: WebSocket, requestId: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let opened = false
		const cleanup = () => {
			clearTimeout(timer)
			socket.removeEventListener("open", onOpen)
			socket.removeEventListener("error", onError)
			socket.removeEventListener("message", onMessage)
		}
		const fail = (err: Error) => {
			cleanup()
			reject(err)
		}

		const timer = setTimeout(() => fail(new Error(opened ? "initialize timed out" : "connect timed out")), CONNECT_TIMEOUT_MS)

		const onOpen = () => {
			opened = true
			socket.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: requestId,
					method: "initialize",
					params: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "pi-lovely-ide", version: "0.1.0" }
					}
				})
			)
		}

		const onError = () => fail(new Error("websocket error"))

		const onMessage = (event: Event) => {
			const data = (event as unknown as { data: unknown }).data
			const raw = typeof data === "string" ? data : String(data)
			const msg = parseJsonRpcMessage(raw)
			if (!msg) return

			if (msg.id === requestId && msg.method == null) {
				cleanup()
				if (msg.error) reject(new Error(`initialize failed: ${JSON.stringify(msg.error)}`))
				else resolve()
			}
		}

		socket.addEventListener("open", onOpen)
		socket.addEventListener("error", onError)
		socket.addEventListener("message", onMessage)
	})
}

export interface IdeConnectionOptions {
	port: number
	authToken: string
	requestId: number
	onMessage(message: JsonRpcMessage, connection: IdeConnection): void
	onClose(connection: IdeConnection): void
}

export class IdeConnection {
	private socket: WebSocket | null = null

	constructor(private readonly options: IdeConnectionOptions) {}

	async connect(): Promise<void> {
		const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}`, {
			protocols: ["mcp"],
			headers: { "x-claude-code-ide-authorization": this.options.authToken }
		})
		this.socket = socket

		try {
			await openAndInitialize(socket, this.options.requestId)
		} catch (err) {
			socket.close()
			if (this.socket === socket) this.socket = null
			throw err
		}

		socket.addEventListener("message", event => {
			const data = (event as unknown as { data: unknown }).data
			const raw = typeof data === "string" ? data : String(data)
			const msg = parseJsonRpcMessage(raw)
			if (msg) this.options.onMessage(msg, this)
		})
		socket.addEventListener("close", () => this.options.onClose(this))

		this.send({ jsonrpc: "2.0", method: "notifications/initialized" })
	}

	send(message: JsonRpcMessage): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
		this.socket.send(JSON.stringify(message))
	}

	close(): void {
		this.socket?.close()
		this.socket = null
	}
}
