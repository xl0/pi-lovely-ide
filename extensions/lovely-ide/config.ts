import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as v from "valibot"
import { DEFAULT_SELECTED_TEXT_LINE_LIMIT, type SelectedTextLineLimit } from "./selection.js"

const CONFIG_FILE = "xl0-lovely-ide.json"

const ConfigSchema = v.looseObject({
	autoConnectOnStartup: v.optional(v.boolean()),
	autoReconnect: v.optional(v.boolean()),
	selectionContext: v.optional(v.boolean()),
	selectedTextLineLimit: v.optional(v.union([v.literal(0), v.literal(3), v.literal(5), v.literal(9)])),
	displaySelectionMessages: v.optional(v.boolean()),
	debugNotifications: v.optional(v.boolean())
})

export type ConfigKey =
	| "autoConnectOnStartup"
	| "autoReconnect"
	| "selectionContext"
	| "selectedTextLineLimit"
	| "displaySelectionMessages"
	| "debugNotifications"
export type ToggleKey = Exclude<ConfigKey, "selectedTextLineLimit">

export class ConfigState {
	#projectDir: string | undefined
	autoConnectOnStartup = true
	autoReconnect = true
	selectionContext = true
	selectedTextLineLimit: SelectedTextLineLimit = DEFAULT_SELECTED_TEXT_LINE_LIMIT
	displaySelectionMessages = false
	debugNotifications = false

	setProjectDir(projectDir: string): void {
		this.#projectDir = projectDir
	}

	get disabled(): boolean {
		return !this.autoConnectOnStartup && !this.autoReconnect
	}

	async load(): Promise<void> {
		if (!this.#projectDir) return
		let parsed: unknown
		try {
			parsed = JSON.parse(await readFile(this.path(), "utf8"))
		} catch {
			return
		}

		const result = v.safeParse(ConfigSchema, parsed)
		if (!result.success) return
		const config = result.output
		if (config.autoConnectOnStartup !== undefined) this.autoConnectOnStartup = config.autoConnectOnStartup
		if (config.autoReconnect !== undefined) this.autoReconnect = config.autoReconnect
		if (config.selectionContext !== undefined) this.selectionContext = config.selectionContext
		if (config.selectedTextLineLimit !== undefined) this.selectedTextLineLimit = config.selectedTextLineLimit
		if (config.displaySelectionMessages !== undefined) this.displaySelectionMessages = config.displaySelectionMessages
		if (config.debugNotifications !== undefined) this.debugNotifications = config.debugNotifications
	}

	async save(): Promise<void> {
		if (!this.#projectDir) return
		await mkdir(join(this.#projectDir, ".pi"), { recursive: true })
		await writeFile(
			this.path(),
			`${JSON.stringify(
				{
					autoConnectOnStartup: this.autoConnectOnStartup,
					autoReconnect: this.autoReconnect,
					selectionContext: this.selectionContext,
					selectedTextLineLimit: this.selectedTextLineLimit,
					displaySelectionMessages: this.displaySelectionMessages,
					debugNotifications: this.debugNotifications
				},
				null,
				"\t"
			)}\n`,
			"utf8"
		)
	}

	private path(): string {
		if (!this.#projectDir) throw new Error("Config project dir unset")
		return join(this.#projectDir, ".pi", CONFIG_FILE)
	}
}
