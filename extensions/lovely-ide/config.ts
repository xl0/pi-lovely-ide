import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import Type, { type Static } from "typebox"
import { Compile } from "typebox/compile"

const CONFIG_FILE = "xl0-lovely-ide.json"

const ConfigSchema = Type.Object(
	{
		autoConnectOnStartup: Type.Optional(Type.Boolean()),
		autoReconnect: Type.Optional(Type.Boolean()),
		selectionContext: Type.Optional(Type.Boolean())
	},
	{ additionalProperties: true }
)

export type ToggleKey = keyof Static<typeof ConfigSchema>

const ConfigValidator = Compile(ConfigSchema)

export class ConfigState {
	#projectDir: string | undefined
	autoConnectOnStartup = true
	autoReconnect = true
	selectionContext = true

	setProjectDir(projectDir: string): void {
		this.#projectDir = projectDir
	}

	get disabled(): boolean {
		return !this.autoConnectOnStartup && !this.autoReconnect
	}

	get(key: ToggleKey): boolean {
		return this[key]
	}

	toggle(key: ToggleKey): boolean {
		this[key] = !this[key]
		return this[key]
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
					selectionContext: this.selectionContext
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
