import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"
import { ScopedConfigEditor } from "@xl0/pi-lovely-config"
import type { ConfigState } from "./config.js"
import { formatSelectionContext, type SelectionSnapshot } from "./selection.js"

export interface CommandIde {
	port: number
	lock: {
		pid?: number | undefined
		ide?: string | undefined
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

const PREVIEW_SELECTED_TEXT = [
	"function summarizeSelection(selection: SelectionSnapshot): string {",
	"\tconst file = displayPath(selection.filePath)",
	'\tconst range = selection.range ? "#" + selection.range.lineStart + "-" + selection.range.lineEnd : ""',
	"\treturn file + range",
	"}"
].join("\n")

const PREVIEW_SELECTION: SelectionSnapshot = {
	filePath: "src/example.ts",
	range: {
		lineStart: 12,
		lineEnd: 16,
		characterStart: 1,
		characterEnd: 2,
		isCursor: false
	},
	text: {
		head: PREVIEW_SELECTED_TEXT,
		totalCharacters: PREVIEW_SELECTED_TEXT.length,
		totalLines: 5
	}
}

export function registerIdeCommand<TIde extends CommandIde>(pi: ExtensionAPI, deps: IdeCommandDeps<TIde>): void {
	pi.registerCommand("ide", {
		description: "Connect to an IDE or configure IDE integration",
		handler: async (_args, ctx) => {
			const ides = await deps.discoverMatchingIdes(ctx.cwd)

			function selectionPreviewText(): string {
				if (!deps.config.value.selectionContext) return ""
				const snapshot = connected ? (deps.selectionSnapshot() ?? PREVIEW_SELECTION) : PREVIEW_SELECTION
				return `\`\`\`\n${formatSelectionContext(snapshot, path => path, deps.config.value.selectedTextLineLimit)}\n\`\`\``
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
				{ value: "Configure", label: "Settings", description: "Edit user and workspace config" }
			]

			let initialIndex = items.length - 1
			if (connected) {
				const idx = items.findIndex(i => i.value === connected.port.toString())
				if (idx !== -1) initialIndex = idx
			}

			let clearSelectionPreviewRefresh = false
			let result: { action: "connect"; ide: TIde } | { action: "configure" } | { action: "disconnect" } | undefined
			try {
				result = await ctx.ui.custom<{ action: "connect"; ide: TIde } | { action: "configure" } | { action: "disconnect" } | undefined>(
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
							} else if (item.value === "Configure") {
								done({ action: "configure" })
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
						container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0))
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

						return {
							render: (w: number) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
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
			} else if (result.action === "configure") {
				let debugNotifications = deps.config.value.debugNotifications
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
					return new ScopedConfigEditor({
						tui,
						theme,
						config: deps.config,
						onChange: config => {
							if (debugNotifications && !config.value.debugNotifications) deps.clearDebugNotificationMessages()
							debugNotifications = config.value.debugNotifications
							deps.updateStatus()
						},
						done
					})
				})
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
