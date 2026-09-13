import type { HelloParams, IdeLocationEventParams, IdeLockFile, JsonRpcMessage } from "../../packages/protocol/src/index.js"
import { IdeConnection } from "./connection.js"
import { SelectionState } from "./selection.js"

export interface DiscoveredIde {
	port: number
	lock: IdeLockFile
}

interface ConnectionState {
	ide: DiscoveredIde
	selection: SelectionState
	ready: boolean
}

interface ConnectionOptions {
	discover(): Promise<DiscoveredIde[]>
	hello(): HelloParams | null
	autoReconnect(): boolean
	displayPath(path: string): string
	onMessage(message: JsonRpcMessage, raw: string, source: IdeConnection): void
	onChange(): void
}

/** Session-local connections: one endpoint per advertised app name, independent of PID. */
export class IdeConnections {
	private readonly entries = new Map<IdeConnection, ConnectionState>()
	private readonly disabled = new Set<string>()
	private readonly preferred = new Map<string, DiscoveredIde>()
	private activeSource: IdeConnection | undefined
	private timer: ReturnType<typeof setTimeout> | undefined
	private generation = 0
	private automatic = false
	private scanGeneration: number | undefined
	private requestId = 1

	constructor(private readonly options: ConnectionOptions) {}

	get connected(): DiscoveredIde[] {
		return [...this.entries.values()].filter(entry => entry.ready).map(entry => entry.ide)
	}

	get active(): DiscoveredIde | undefined {
		return this.activeSource ? this.entries.get(this.activeSource)?.ide : undefined
	}

	get selection(): SelectionState | undefined {
		return this.activeSource ? this.entries.get(this.activeSource)?.selection : undefined
	}

	get(source: IdeConnection): DiscoveredIde | undefined {
		return this.entries.get(source)?.ide
	}

	select(source: IdeConnection, event: IdeLocationEventParams): void {
		const entry = this.entries.get(source)
		if (!entry) return
		entry.selection.setCurrent(event)
		this.activeSource = source
		this.options.onChange()
	}

	send(message: JsonRpcMessage): void {
		for (const [connection, entry] of this.entries) {
			if (entry.ready) connection.send(message)
		}
	}

	async start(): Promise<void> {
		this.automatic = true
		await this.scan()
	}

	async connect(ide: DiscoveredIde): Promise<void> {
		const app = ide.lock.ide ?? "IDE"
		this.disabled.delete(app)
		this.preferred.set(app, ide)
		this.automatic = true
		for (const [connection, entry] of this.entries) {
			if ((entry.ide.lock.ide ?? "IDE") !== app) continue
			if (entry.ide.port === ide.port && entry.ide.lock.token === ide.lock.token) return
			this.remove(connection)
		}
		try {
			await this.open(ide)
		} finally {
			this.scheduleReconnect()
		}
	}

	/** Manual disconnect suppresses this app until explicitly reconnected (or a new session). */
	disconnect(ide?: DiscoveredIde): void {
		if (ide) this.disabled.add(ide.lock.ide ?? "IDE")
		else {
			this.automatic = false
			this.clearTimer()
		}
		for (const [connection, entry] of this.entries) {
			if (ide && (entry.ide.lock.ide ?? "IDE") !== (ide.lock.ide ?? "IDE")) continue
			this.disabled.add(entry.ide.lock.ide ?? "IDE")
			this.remove(connection)
		}
		this.options.onChange()
	}

	stop(): void {
		this.generation++
		this.automatic = false
		this.clearTimer()
		for (const connection of this.entries.keys()) this.remove(connection)
		this.disabled.clear()
		this.preferred.clear()
		this.options.onChange()
	}

	scheduleReconnect(): void {
		this.clearTimer()
		if (!this.automatic || !this.options.autoReconnect()) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			if (this.automatic && this.options.autoReconnect()) void this.scan()
		}, 1_000)
		this.timer.unref()
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}

	private remove(connection: IdeConnection): void {
		this.entries.delete(connection)
		if (this.activeSource === connection) this.activeSource = undefined
		connection.close()
	}

	private async open(ide: DiscoveredIde): Promise<void> {
		const hello = this.options.hello()
		if (!hello) return
		const connection = new IdeConnection({
			port: ide.port,
			token: ide.lock.token,
			requestId: this.requestId++,
			hello,
			onMessage: this.options.onMessage,
			onClose: source => {
				if (!this.entries.has(source)) return
				this.remove(source)
				this.options.onChange()
				this.scheduleReconnect()
			}
		})
		const entry = { ide, selection: new SelectionState(this.options.displayPath, ide.lock.ide ?? "IDE"), ready: false }
		this.entries.set(connection, entry)
		try {
			await connection.connect()
			if (!this.entries.has(connection)) return
			entry.ready = true
			this.preferred.set(ide.lock.ide ?? "IDE", ide)
		} catch (error) {
			this.remove(connection)
			throw error
		} finally {
			this.options.onChange()
		}
	}

	private async scan(): Promise<void> {
		if (this.scanGeneration === this.generation || !this.automatic) return
		const generation = this.generation
		this.scanGeneration = generation
		try {
			const ides = await this.options.discover()
			if (generation !== this.generation || !this.automatic) return
			const groups = new Map<string, DiscoveredIde[]>()
			for (const ide of ides) {
				const app = ide.lock.ide ?? "IDE"
				const group = groups.get(app) ?? []
				group.push(ide)
				groups.set(app, group)
			}
			const attempts: Promise<void>[] = []
			for (const [app, candidates] of groups) {
				if (this.disabled.has(app) || [...this.entries.values()].some(entry => (entry.ide.lock.ide ?? "IDE") === app)) continue
				const preferred = this.preferred.get(app)
				const ide =
					candidates.length === 1
						? candidates[0]
						: candidates.find(candidate => candidate.port === preferred?.port && candidate.lock.token === preferred.lock.token)
				// Multiple windows of the same app need an explicit /ide choice, not filesystem ordering.
				if (ide) attempts.push(this.open(ide))
			}
			// Each endpoint can fail/retry independently without delaying another app's connection.
			await Promise.allSettled(attempts)
		} finally {
			if (this.scanGeneration === generation) {
				this.scanGeneration = undefined
				this.options.onChange()
				if (generation === this.generation) this.scheduleReconnect()
			}
		}
	}
}
