import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { commandUrl, type Command } from './commands.js'
import { DEFAULT_CONFIG, GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import {
	diffValues,
	presetCounts,
	speakerCount,
	variableNames,
	variableValues,
	type CueDeckState,
	type VarValue,
} from './state.js'
import { UpgradeScripts } from './upgrades.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: Record<string, VarValue>
}

export { UpgradeScripts }

/**
 * Модуль CueDeck для Bitfocus Companion.
 *
 * Связь — тот же HTTP API, что у родной программы Stream Deck и у готовой
 * страницы: команды `GET /api/<команда>`, состояние — опрос `GET /api/state`
 * четыре раза в секунду (таймер на кнопке идёт без рывков, а CueDeck менять
 * не нужно — модуль работает с любой версией, где есть внешнее управление).
 */

/** Как часто спрашивать состояние, пока связь есть. */
const POLL_MS = 250
/** Как часто стучаться, пока связи нет. */
const RETRY_MS = 1000
const REQUEST_TIMEOUT_MS = 1500
/** Сколько неудачных опросов подряд — и кнопки гаснут («нет связи»): одна потеря пакета не в счёт. */
const FAILS_TO_OFFLINE = 3

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config: ModuleConfig = { ...DEFAULT_CONFIG }
	/** Последнее состояние CueDeck; null — связи нет. */
	state: CueDeckState | null = null

	private pollTimer: NodeJS.Timeout | null = null
	private generation = 0
	private fails = 0
	private lastValues = new Map<string, VarValue>()
	private varShape = ''
	private lastError = ''
	/** Номер опроса: после нажатия опросы могут пересечься — старый ответ не должен затереть новый. */
	private reqSeq = 0
	private appliedSeq = 0

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.applyConfig(config)
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()
		this.start()
	}

	async destroy(): Promise<void> {
		this.stop()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const prevLang = this.config.lang
		this.applyConfig(config)
		if (config.lang !== prevLang) this.updatePresets()
		this.start()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		this.varShape = this.shapeOf(this.state)
		this.setVariableDefinitions(
			Object.fromEntries(Object.entries(variableNames(this.state)).map(([id, name]) => [id, { name }])),
		)
		this.lastValues.clear()
	}

	// ── Команды ──────────────────────────────────────────────────────────────

	async sendCommand(c: Command): Promise<void> {
		const url = this.baseUrl() + commandUrl(c)
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
			const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
			if (!res.ok || body?.ok === false) {
				this.log('warn', `CueDeck: ${c.path} — ${body?.error ?? `HTTP ${res.status}`}`)
			}
		} catch (err) {
			this.log('warn', `CueDeck: ${c.path} не отправлено — ${this.describe(err)}`)
		}
		// Кнопка должна перекраситься сразу после нажатия, а не на следующем тике.
		this.pollNow()
	}

	// ── Опрос состояния ──────────────────────────────────────────────────────

	private applyConfig(config: ModuleConfig): void {
		this.config = {
			host: (config.host ?? '').trim() || DEFAULT_CONFIG.host,
			port: Number(config.port) || DEFAULT_CONFIG.port,
			lang: config.lang === 'ru' ? 'ru' : 'en',
		}
	}

	private baseUrl(): string {
		const h =
			this.config.host.includes(':') && !this.config.host.startsWith('[') ? `[${this.config.host}]` : this.config.host
		return `http://${h}:${this.config.port}`
	}

	private start(): void {
		this.stop()
		this.fails = 0
		this.lastError = ''
		this.updateStatus(InstanceStatus.Connecting, `${this.config.host}:${this.config.port}`)
		this.schedule(0)
	}

	private stop(): void {
		this.generation++
		if (this.pollTimer) clearTimeout(this.pollTimer)
		this.pollTimer = null
	}

	private schedule(ms: number): void {
		if (this.pollTimer) clearTimeout(this.pollTimer)
		const gen = this.generation
		this.pollTimer = setTimeout(() => void this.poll(gen), ms)
	}

	private pollNow(): void {
		this.schedule(0)
	}

	private async poll(gen: number): Promise<void> {
		this.pollTimer = null
		let next = POLL_MS
		const seq = ++this.reqSeq
		try {
			const res = await fetch(`${this.baseUrl()}/api/state`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
			if (gen !== this.generation) return
			if (res.status === 403) {
				throw new Error('CueDeck принимает команды только со своего компьютера — включи там «Из сети»')
			}
			if (!res.ok) throw new Error(`CueDeck ответил HTTP ${res.status}`)
			const body = (await res.json()) as CueDeckState
			if (gen !== this.generation) return
			if (body?.app !== 'CueDeck' || !body.timer) throw new Error('по этому адресу отвечает не CueDeck')
			if (seq < this.appliedSeq) return
			this.appliedSeq = seq
			this.fails = 0
			if (this.lastError || this.state === null) {
				this.lastError = ''
				this.updateStatus(InstanceStatus.Ok, `CueDeck ${body.version}`)
			}
			this.setState(body)
		} catch (err) {
			if (gen !== this.generation) return
			this.fails++
			next = RETRY_MS
			const msg = this.describe(err)
			if (msg !== this.lastError) {
				this.lastError = msg
				this.updateStatus(InstanceStatus.ConnectionFailure, msg)
				this.log('warn', `CueDeck ${this.config.host}:${this.config.port}: ${msg}`)
			}
			if (this.fails >= FAILS_TO_OFFLINE && this.state !== null) this.setState(null)
		}
		if (gen === this.generation && !this.pollTimer) this.schedule(next)
	}

	private shapeOf(s: CueDeckState | null): string {
		const p = presetCounts(s)
		return `${speakerCount(s)}/${p.timer}/${p.message}`
	}

	private setState(s: CueDeckState | null): void {
		const wasOver = !!this.state?.timer.overtime
		this.state = s
		// Список переменных зависит от длины плейлиста и числа пресетов.
		if (this.shapeOf(s) !== this.varShape) this.updateVariableDefinitions()
		const changed = diffValues(variableValues(s), this.lastValues)
		if (Object.keys(changed).length) {
			this.setVariableValues(changed)
			for (const [k, v] of Object.entries(changed)) this.lastValues.set(k, v)
			this.checkAllFeedbacks()
		} else if (wasOver || s?.timer.overtime) {
			// Мигание «время вышло» меняется само по себе, без изменения данных.
			this.checkFeedbacks('timer_over')
		}
	}

	private describe(err: unknown): string {
		const code = (err as { cause?: { code?: string } })?.cause?.code
		if (code === 'ECONNREFUSED') {
			return `CueDeck не отвечает на ${this.config.host}:${this.config.port} — он запущен, внешнее управление включено?`
		}
		if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `нет сети до ${this.config.host}`
		if ((err as Error)?.name === 'TimeoutError') return `CueDeck на ${this.config.host} не ответил вовремя`
		return err instanceof Error ? err.message : String(err)
	}
}
