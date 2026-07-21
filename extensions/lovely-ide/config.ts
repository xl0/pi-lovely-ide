import { defineScopedConfig, field } from "@xl0/pi-lovely-config"
import { DEFAULT_SELECTED_TEXT_LINE_LIMIT, SELECTED_TEXT_LINE_LIMITS } from "./selection.js"

export function createConfigState() {
	return defineScopedConfig({
		fileName: "xl0-lovely-ide.json",
		schema: {
			autoConnectOnStartup: field.boolean(true, {
				label: "Auto-connect on startup",
				description: "Connect automatically to a matching IDE when Pi starts"
			}),
			autoReconnect: field.boolean(true, {
				label: "Auto-reconnect on loss",
				description: "Reconnect automatically when the IDE connection closes"
			}),
			selectionContext: field.boolean(true, {
				label: "Selection context",
				description: "Attach current IDE selection to the next eligible prompt"
			}),
			selectedTextLineLimit: field.number(DEFAULT_SELECTED_TEXT_LINE_LIMIT, {
				label: "Selection text lines",
				description: "Maximum selected text lines shown in model context; 0 disables selected text",
				values: SELECTED_TEXT_LINE_LIMITS,
				valueDescriptions: {
					0: "Do not include selected text",
					3: "Include up to 3 lines",
					5: "Include up to 5 lines",
					9: "Include up to 9 lines"
				}
			}),
			displaySelectionMessages: field.boolean(false, {
				label: "Display context messages",
				description: "Show injected IDE context messages in the transcript"
			}),
			debugNotifications: field.boolean(false, {
				label: "Debug raw IDE notifications",
				description: "Show incoming IDE notifications as JSON in the transcript"
			})
		}
	})
}

export type ConfigState = ReturnType<typeof createConfigState>
