import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"
import type { ConfigState, ToggleKey } from "./config.js"
import { formatSelectionContext, SELECTED_TEXT_LINE_LIMITS, type SelectionSnapshot } from "./selection.js"

export interface CommandIde {
	port: number
	lock: {
		pid?: number
		ide?: string
	}
}

interface IdeCommandDeps<TIde extends CommandIde> {
	config: ConfigState
	discoverMatchingIdes(cwd: string): Promise<TIde[]>
	connected(): TIde | null
	connect(ide: TIde): Promise<void>
	disconnect(): void
	updateStatus(): void
	scheduleReconnect(): void
	selectionSnapshot(): SelectionSnapshot | null
	setSelectionPreviewRefresh(refresh: (() => void) | null): void
	clearDebugNotificationMessages(): void
}

const TOGGLE_LABELS: Record<ToggleKey, string> = {
	autoConnectOnStartup: "Auto-connect on startup",
	autoReconnect: "Auto-reconnect on loss",
	selectionContext: "Selection context",
	displaySelectionMessages: "Display context messages",
	debugNotifications: "Debug raw IDE notifications"
}

const TOGGLE_KEYS = new Set<ToggleKey>([
	"autoConnectOnStartup",
	"autoReconnect",
	"selectionContext",
	"displaySelectionMessages",
	"debugNotifications"
])

function isToggleItem(value: string): value is ToggleKey {
	return TOGGLE_KEYS.has(value as ToggleKey)
}

function nextSelectedTextLineLimit(value: ConfigState["selectedTextLineLimit"]): ConfigState["selectedTextLineLimit"] {
	const idx = SELECTED_TEXT_LINE_LIMITS.indexOf(value)
	return SELECTED_TEXT_LINE_LIMITS[(idx + 1) % SELECTED_TEXT_LINE_LIMITS.length] ?? SELECTED_TEXT_LINE_LIMITS[0]
}

const PREVIEW_SELECTION: SelectionSnapshot = {
	filePath: "extensions/lovely-ide/command.ts",
	lineStart: 83,
	lineEnd: 83,
	characterStart: 38,
	characterEnd: 38,
	isCursor: true
}

function saveConfigBestEffort(config: ConfigState): void {
	void config.save().catch(() => undefined)
}

export function registerIdeCommand<TIde extends CommandIde>(pi: ExtensionAPI, deps: IdeCommandDeps<TIde>): void {
	pi.registerCommand("ide", {
		description: "Connect to an IDE, toggle auto-connect/reconnect/context/debug displays",
		handler: async (_args, ctx) => {
			const ides = await deps.discoverMatchingIdes(ctx.cwd)

			function labelForToggle(key: ToggleKey): string {
				return `${TOGGLE_LABELS[key]}  ${deps.config[key] ? "on" : "off"}`
			}

			function labelForSelectedTextLineLimit(): string {
				const value = deps.config.selectedTextLineLimit
				return `Selection text lines  ${value === 0 ? "off" : value}`
			}

			function selectionPreviewText(): string {
				if (!deps.config.selectionContext) return ""
				const snapshot = connected ? (deps.selectionSnapshot() ?? PREVIEW_SELECTION) : PREVIEW_SELECTION
				return `\`\`\`\n${formatSelectionContext(snapshot, path => path, deps.config.selectedTextLineLimit)}\n\`\`\``
			}

			const connected = deps.connected()
			const items: SelectItem[] = [
				...ides.map((ide): SelectItem => {
					const name = ide.lock.ide ?? "IDE"
					const pid = ide.lock.pid ?? "?"
					const cur = connected?.port === ide.port ? " (current)" : ""
					return { value: ide.port.toString(), label: `${name} ${pid}${cur}` }
				}),
				{ value: "Disconnect", label: "Disconnect" },
				{ value: "autoConnectOnStartup", label: labelForToggle("autoConnectOnStartup") },
				{ value: "autoReconnect", label: labelForToggle("autoReconnect") },
				{ value: "selectionContext", label: labelForToggle("selectionContext") },
				{ value: "selectedTextLineLimit", label: labelForSelectedTextLineLimit() },
				{ value: "displaySelectionMessages", label: labelForToggle("displaySelectionMessages") },
				{ value: "debugNotifications", label: labelForToggle("debugNotifications") }
			]

			let initialIndex = items.length - 1
			if (connected) {
				const idx = items.findIndex(i => i.value === connected.port.toString())
				if (idx !== -1) initialIndex = idx
			}

			let clearSelectionPreviewRefresh = false
			let result: { action: "connect"; ide: TIde } | { action: "toggle" } | { action: "disconnect" } | undefined
			try {
				result = await ctx.ui.custom<{ action: "connect"; ide: TIde } | { action: "toggle" } | { action: "disconnect" } | undefined>(
					(tui, theme, _kb, done) => {
						const container = new Container()

						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
						container.addChild(new Text(theme.fg("accent", theme.bold("IDE Connection")), 1, 0))

						const selectList = new SelectList(items, Math.min(items.length, 12), {
							selectedPrefix: (t: string) => theme.fg("accent", t),
							selectedText: (t: string) => theme.fg("accent", t),
							description: (t: string) => theme.fg("muted", t),
							scrollInfo: (t: string) => theme.fg("dim", t),
							noMatch: (t: string) => theme.fg("warning", t)
						})
						selectList.setSelectedIndex(initialIndex)

						selectList.onSelect = item => {
							if (item.value === "Disconnect") {
								done({ action: "disconnect" })
							} else if (isToggleItem(item.value) || item.value === "selectedTextLineLimit") {
								done({ action: "toggle" })
							} else {
								const ide = ides.find(i => i.port.toString() === item.value)
								if (ide) done({ action: "connect", ide })
							}
						}

						selectList.onCancel = () => {
							done(undefined)
						}

						const preview = new Text(theme.fg("muted", selectionPreviewText()), 1, 0)
						deps.setSelectionPreviewRefresh(() => {
							preview.setText(theme.fg("muted", selectionPreviewText()))
							container.invalidate()
							tui.requestRender()
						})
						clearSelectionPreviewRefresh = true
						container.addChild(preview)
						container.addChild(selectList)
						container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • space toggle • esc cancel"), 1, 0))
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

						return {
							render: (w: number) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								if (matchesKey(data, "space")) {
									const sel = selectList.getSelectedItem()
									if (sel && isToggleItem(sel.value)) {
										deps.config[sel.value] = !deps.config[sel.value]
										if (sel.value === "debugNotifications" && !deps.config.debugNotifications) deps.clearDebugNotificationMessages()
										saveConfigBestEffort(deps.config)
										deps.updateStatus()
										const idx = items.findIndex(i => i.value === sel.value)
										if (idx !== -1) items[idx] = { value: sel.value, label: labelForToggle(sel.value) }
										preview.setText(theme.fg("muted", selectionPreviewText()))
										selectList.invalidate()
										tui.requestRender()
									} else if (sel?.value === "selectedTextLineLimit") {
										deps.config.selectedTextLineLimit = nextSelectedTextLineLimit(deps.config.selectedTextLineLimit)
										saveConfigBestEffort(deps.config)
										const idx = items.findIndex(i => i.value === sel.value)
										if (idx !== -1) items[idx] = { value: sel.value, label: labelForSelectedTextLineLimit() }
										preview.setText(theme.fg("muted", selectionPreviewText()))
										selectList.invalidate()
										tui.requestRender()
									}
									return
								}
								selectList.handleInput(data)
								tui.requestRender()
							}
						}
					}
				)
			} finally {
				if (clearSelectionPreviewRefresh) deps.setSelectionPreviewRefresh(null)
			}

			if (!result) return

			if (result.action === "disconnect") {
				deps.disconnect()
			} else if (result.action === "toggle") {
				saveConfigBestEffort(deps.config)
			} else if (result.action === "connect") {
				try {
					await deps.connect(result.ide)
				} catch (err) {
					deps.updateStatus()
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
					deps.scheduleReconnect()
				}
			}
		}
	})
}
