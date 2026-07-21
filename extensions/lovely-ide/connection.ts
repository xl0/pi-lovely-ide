import { WebSocket } from "undici"
import * as v from "valibot"
import type { HelloParams, JsonRpcMessage } from "../../packages/protocol/src/index.js"
import { HelloResultSchema, PI_IDE_AUTH_HEADER, parseJsonRpcMessage } from "../../packages/protocol/src/index.js"

const CONNECT_TIMEOUT_MS = 3_000

export interface IdeConnectionOptions {
	port: number
	token: string
	requestId: number
	hello: HelloParams
	onMessage(message: JsonRpcMessage, raw: string, connection: IdeConnection): void
	onClose(connection: IdeConnection): void
}

export class IdeConnection {
	private socket: WebSocket | null = null

	constructor(private readonly options: IdeConnectionOptions) {}

	async connect(): Promise<void> {
		const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}`, {
			headers: { [PI_IDE_AUTH_HEADER]: this.options.token }
		})
		this.socket = socket

		let opened = false
		let connected = false
		let settled = false

		const helloPromise = new Promise<void>((resolve, reject) => {
			const cleanupHandshake = () => {
				clearTimeout(timer)
				socket.removeEventListener("open", onOpen)
				socket.removeEventListener("error", onError)
			}

			const fail = (err: Error) => {
				if (settled) return
				settled = true
				cleanupHandshake()
				socket.removeEventListener("message", onMessage)
				socket.removeEventListener("close", onClose)
				reject(err)
			}

			const succeed = () => {
				if (settled) return
				settled = true
				connected = true
				cleanupHandshake()
				resolve()
			}

			const timer = setTimeout(() => fail(new Error(opened ? "hello timed out" : "connect timed out")), CONNECT_TIMEOUT_MS)

			const onOpen = () => {
				opened = true
				const message: JsonRpcMessage = { jsonrpc: "2.0", id: this.options.requestId, method: "hello", params: this.options.hello }
				socket.send(JSON.stringify(message))
			}

			const onError = () => fail(new Error("websocket error"))

			const onMessage = (event: Event) => {
				if (this.socket !== socket) return
				const data = (event as unknown as { data: unknown }).data
				const raw = typeof data === "string" ? data : String(data)
				const msg = parseJsonRpcMessage(raw)
				if (!msg) return

				if (!connected) {
					if (msg.id !== this.options.requestId || msg.method != null) return
					if (msg.error) {
						fail(new Error(`hello failed: ${JSON.stringify(msg.error)}`))
						return
					}
					if (!v.is(HelloResultSchema, msg.result)) {
						fail(new Error(`hello failed: invalid result ${JSON.stringify(msg.result)}`))
						return
					}
					succeed()
					return
				}

				this.options.onMessage(msg, raw, this)
			}

			const onClose = () => {
				if (this.socket === socket) this.socket = null
				if (!connected) {
					fail(new Error("websocket closed"))
					return
				}
				this.options.onClose(this)
			}

			socket.addEventListener("open", onOpen)
			socket.addEventListener("error", onError)
			socket.addEventListener("message", onMessage)
			socket.addEventListener("close", onClose)
		})

		try {
			await helloPromise
		} catch (err) {
			socket.close()
			if (this.socket === socket) this.socket = null
			throw err
		}
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
