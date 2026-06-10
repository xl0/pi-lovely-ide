import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"
import { DEFAULT_SELECTED_TEXT_LINE_LIMIT, type SelectedTextLineLimit } from "./selection.js"

const CONFIG_FILE = "xl0-lovely-ide.json"

const ConfigSchema = Type.Object(
	{
		autoConnectOnStartup: Type.Optional(Type.Boolean()),
		autoReconnect: Type.Optional(Type.Boolean()),
		selectionContext: Type.Optional(Type.Boolean()),
		selectedTextLineLimit: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(3), Type.Literal(5), Type.Literal(9)])),
		displaySelectionMessages: Type.Optional(Type.Boolean()),
		debugNotifications: Type.Optional(Type.Boolean())
	},
	{ additionalProperties: true }
)

export type ConfigKey = keyof Static<typeof ConfigSchema>
export type ToggleKey = Exclude<ConfigKey, "selectedTextLineLimit">

const ConfigValidator = Compile(ConfigSchema)

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

		if (!ConfigValidator.Check(parsed)) return
		if (parsed.autoConnectOnStartup !== undefined) this.autoConnectOnStartup = parsed.autoConnectOnStartup
		if (parsed.autoReconnect !== undefined) this.autoReconnect = parsed.autoReconnect
		if (parsed.selectionContext !== undefined) this.selectionContext = parsed.selectionContext
		if (parsed.selectedTextLineLimit !== undefined) this.selectedTextLineLimit = parsed.selectedTextLineLimit
		if (parsed.displaySelectionMessages !== undefined) this.displaySelectionMessages = parsed.displaySelectionMessages
		if (parsed.debugNotifications !== undefined) this.debugNotifications = parsed.debugNotifications
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
