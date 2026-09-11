import assert from "node:assert/strict"
import { once } from "node:events"
import { afterEach, test } from "node:test"
import { type DiscoveredIde, IdeConnections } from "../extensions/lovely-ide/connections.js"
import { WebSocketServer } from "../ide-plugins/vscode/node_modules/ws/index.js"
import { type HelloParams, type IdeLocationEventParams, parseIdeJsonRpcMessage } from "../packages/protocol/src/index.js"

const servers: WebSocketServer[] = []
const pools: IdeConnections[] = []
afterEach(async () => {
	for (const pool of pools.splice(0)) pool.stop()
	for (const server of servers.splice(0)) {
		for (const socket of server.clients) socket.terminate()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
})

const hello: HelloParams = {
	version: 1,
	client: { name: "test", pid: process.pid },
	session: { id: "test" },
	connection: { id: "test", subscriptions: ["selection", "mention"] },
	workspace: "/test"
}

async function endpoint(name: string, initialSelection?: string) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
	servers.push(server)
	await once(server, "listening")
	const address = server.address()
	assert(address && typeof address !== "string")
	const messages: { method: string; params: unknown }[] = []
	server.on("connection", socket => {
		socket.on("message", raw => {
			const message = JSON.parse(raw.toString())
			messages.push(message)
			if (message.method === "hello") {
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { version: 1 } }))
				if (initialSelection) {
					socket.send(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "event",
							params: { type: "selection", file: initialSelection, spans: [] }
						})
					)
				}
			}
		})
	})
	const ide: DiscoveredIde = {
		port: address.port,
		lock: { protocol: "pi-ide", version: 1, port: address.port, pid: process.pid, workspaces: ["/test"], ide: name, token: "test" }
	}
	return {
		ide,
		server,
		messages,
		select(file: string | null) {
			const params: IdeLocationEventParams = { type: "selection", file, spans: [] }
			for (const socket of server.clients) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params }))
		}
	}
}

function pool(discover: () => Promise<DiscoveredIde[]>) {
	const connections = new IdeConnections({
		discover,
		hello: () => hello,
		autoReconnect: () => true,
		displayPath: path => path,
		onChange() {},
		onMessage(message, _raw, source) {
			const parsed = parseIdeJsonRpcMessage(message)
			if (parsed.kind === "event" && parsed.params.type === "selection") connections.select(source, parsed.params)
		}
	})
	pools.push(connections)
	return connections
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5_000
	while (!predicate()) {
		assert(Date.now() < deadline, "condition timed out")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

test("distinct apps sharing a PID coexist; only latest activity supplies context", async () => {
	const code = await endpoint("VS Code")
	const notes = await endpoint("Obsidian")
	const connections = pool(async () => [code.ide, notes.ide])
	await connections.start()
	assert.equal(connections.connected.length, 2)
	assert.equal(connections.active, undefined)
	code.select("/test/code.ts")
	await until(() => connections.active === code.ide)
	notes.select("/test/note.md")
	await until(() => connections.active === notes.ide)
	assert.equal(connections.selection?.snapshotCurrent()?.filePath, "/test/note.md")
	connections.send({ jsonrpc: "2.0", method: "session_info_changed", params: { name: "renamed" } })
	await until(() => [code, notes].every(peer => peer.messages.some(message => message.method === "session_info_changed")))
	connections.disconnect(code.ide)
	assert.equal(connections.active, notes.ide)
	assert.equal(connections.selection?.snapshotCurrent()?.filePath, "/test/note.md")
	notes.select(null)
	await until(() => connections.selection?.snapshotCurrent() === null)
})

test("selection sent immediately after hello is retained through connection setup", async () => {
	const code = await endpoint("VS Code", "/test/code.ts")
	const connections = pool(async () => [code.ide])
	await connections.start()
	await until(() => connections.active === code.ide)
	assert.equal(connections.selection?.snapshotCurrent()?.filePath, "/test/code.ts")
})

test("ambiguous apps need a choice; late discovery respects manual disconnects", async () => {
	const code = await endpoint("VS Code")
	const otherCode = await endpoint("VS Code")
	const notes = await endpoint("Obsidian")
	const candidates = [code.ide, otherCode.ide, notes.ide]
	const connections = pool(async () => candidates)
	await connections.start()
	assert.deepEqual(connections.connected, [notes.ide])
	await connections.connect(otherCode.ide)
	assert(connections.connected.includes(otherCode.ide))
	connections.disconnect(notes.ide)
	const cursor = await endpoint("Cursor")
	candidates.push(cursor.ide)
	await until(() => connections.connected.includes(cursor.ide))
	assert(!connections.connected.includes(notes.ide))
	assert(!connections.connected.includes(code.ide))
	connections.disconnect()
	await new Promise(resolve => setTimeout(resolve, 1_100))
	assert.equal(connections.connected.length, 0)
})

test("unexpected loss reconnects independently without taking over another app's context", async () => {
	const code = await endpoint("VS Code")
	const notes = await endpoint("Obsidian")
	const connections = pool(async () => [code.ide, notes.ide])
	await connections.start()
	notes.select("/test/note.md")
	await until(() => connections.active === notes.ide)
	for (const socket of code.server.clients) socket.terminate()
	await until(() => connections.connected.length === 1)
	await until(() => connections.connected.length === 2)
	assert.equal(connections.active, notes.ide)
	assert.equal(connections.selection?.snapshotCurrent()?.filePath, "/test/note.md")
})

test("session replacement fences discovery already in flight", async () => {
	const code = await endpoint("VS Code")
	let complete!: (ides: DiscoveredIde[]) => void
	const delayed = new Promise<DiscoveredIde[]>(resolve => {
		complete = resolve
	})
	let calls = 0
	const connections = pool(() => (++calls === 1 ? delayed : Promise.resolve([])))
	const oldStart = connections.start()
	connections.stop()
	await connections.start()
	complete([code.ide])
	await oldStart
	assert.equal(calls, 2)
	assert.equal(connections.connected.length, 0)
	assert.equal(code.server.clients.size, 0)
})
