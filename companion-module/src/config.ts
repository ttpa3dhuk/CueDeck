import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export type Lang = 'ru' | 'en'

/** Язык кнопок в настройках: «auto» — как в интерфейсе CueDeck. */
export type LangSetting = Lang | 'auto'

export type ModuleConfig = {
	host: string
	port: number
	lang: LangSetting
}

// По умолчанию кнопки на языке CueDeck («auto»); пока он не ответил — английский.
// Подключения, где язык выбран руками (en / ru), остаются как были.
export const DEFAULT_CONFIG: ModuleConfig = { host: '127.0.0.1', port: 9420, lang: 'auto' }

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: '',
			width: 12,
			value:
				'In CueDeck: ⚙ Settings → External control → ☑ Enable. ' +
				'Companion on another computer — also ☑ From network, and enter the CueDeck computer’s IP here.<br>' +
				'В CueDeck: ⚙ Настройки → Внешнее управление → ☑ Включить. ' +
				'Companion на другом компьютере — там же ☑ «Из сети», а здесь IP компьютера с CueDeck.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'CueDeck IP / host',
			width: 8,
			default: DEFAULT_CONFIG.host,
			regex: Regex.SOMETHING,
		},
		{
			type: 'number',
			id: 'port',
			label: 'HTTP port',
			width: 4,
			min: 1,
			max: 65535,
			default: DEFAULT_CONFIG.port,
		},
		{
			type: 'dropdown',
			id: 'lang',
			label: 'Preset button language / Язык кнопок в пресетах',
			width: 8,
			default: DEFAULT_CONFIG.lang,
			choices: [
				{ id: 'auto', label: 'Auto (as in CueDeck) / Как в CueDeck' },
				{ id: 'en', label: 'English' },
				{ id: 'ru', label: 'Русский' },
			],
		},
	]
}
