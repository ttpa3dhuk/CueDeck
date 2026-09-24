import { log } from '../diag.js'
import { store } from '../state.js'
import { companionOfflineVars, companionVars, diffVars, type CompanionVars } from './companion-vars.js'

/**
 * Отправка состояния CueDeck в Bitfocus Companion (PLAN 2.18, шаг 3):
 * `POST http://<хост>/api/custom-variable/<имя>/value?value=…` — встроенный
 * HTTP API Companion, модулей не требует. Кнопки готовой страницы
 * (companion/) показывают эти переменные: таймер с миганием на нуле,
 * «осталось N слайдов», остаток ролика, следующий спикер.
 *
 * Почему CueDeck толкает сам, а не Companion опрашивает: опрос в Companion —
 * это триггер по интервалу (не чаще раза в секунду) плюс jsonpath в каждой
 * кнопке, то есть настройка на стороне клиента. Толкание — мгновенно и без
 * настроек: импортировал страницу — работает.
 *
 * Шлём только изменившиеся переменные, раз в 250 мс, строго по одной
 * (без параллельных запросов), и всё целиком раз в 5 с (FULL_RESYNC_MS). Нет ответа — пауза 3 с и полная переотправка
 * после восстановления (Companion мог перезапуститься с пустыми значениями).
 * 404 = переменной нет в Companion = страницу CueDeck не импортировали.
 */

const TICK_MS = 250
const BACKOFF_MS = 3000
const REQUEST_TIMEOUT_MS = 1500
/**
 * Раз в столько всё отправляется заново, даже без изменений: Companion мог
 * перезапуститься или сбросить переменные импортом, а мы об этом не узнаем —
 * кнопки висели бы пустыми до ближайшего изменения.
 */
const FULL_RESYNC_MS = 5000

export type CompanionPushState =
  | { state: 'off' }
  | { state: 'on' }
  | { state: 'error'; error: string }

let host: string | null = null
let timer: NodeJS.Timeout | null = null
let inflight = false
let backoffUntil = 0
let lastFullSync = 0
const lastSent = new Map<string, string>()
let status: CompanionPushState = { state: 'off' }
let onStatus: (s: CompanionPushState) => void = () => undefined

class MissingVariable extends Error {}

function setStatus(next: CompanionPushState): void {
  const same =
    next.state === status.state && (next.state !== 'error' || (status.state === 'error' && next.error === status.error))
  status = next
  if (same) return
  if (next.state === 'error') log.warn(`companion: ${next.error}`)
  else log.info(`companion: ${next.state === 'on' ? 'связь есть' : 'выключено'}`)
  onStatus(next)
}

async function post(name: string, value: string): Promise<void> {
  const url = `http://${host}/api/custom-variable/${encodeURIComponent(name)}/value?value=${encodeURIComponent(value)}`
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (res.status === 404) throw new MissingVariable(name)
  if (!res.ok) throw new Error(`Companion ответил ${res.status}`)
}

async function send(vars: Partial<CompanionVars>): Promise<void> {
  for (const [k, v] of diffVars(vars, lastSent)) {
    await post(k, v)
    lastSent.set(k, v)
  }
}

function describe(err: unknown): string {
  if (err instanceof MissingVariable) {
    return `в Companion нет переменной ${err.message} — импортируй страницу CueDeck`
  }
  const code = (err as { cause?: { code?: string } })?.cause?.code
  if (code === 'ECONNREFUSED') return `Companion не отвечает на ${host} — он запущен?`
  if ((err as Error)?.name === 'TimeoutError') return `Companion на ${host} не ответил вовремя`
  return err instanceof Error ? err.message : String(err)
}

async function tick(): Promise<void> {
  if (!host || inflight || Date.now() < backoffUntil) return
  inflight = true
  if (Date.now() - lastFullSync > FULL_RESYNC_MS) {
    lastSent.clear()
    lastFullSync = Date.now()
  }
  try {
    await send(companionVars(store.get(), Date.now(), store.videoPositionSec()))
    setStatus({ state: 'on' })
  } catch (err) {
    lastSent.clear()
    backoffUntil = Date.now() + BACKOFF_MS
    setStatus({ state: 'error', error: describe(err) })
  } finally {
    inflight = false
  }
}

/** Запустить/перезапустить отправку на `newHost` (`127.0.0.1:8000`); null — выключить. */
export function configureCompanionPush(newHost: string | null, statusCb: (s: CompanionPushState) => void): void {
  onStatus = statusCb
  const changed = newHost !== host
  if (timer && (changed || !newHost)) {
    clearInterval(timer)
    timer = null
  }
  host = newHost
  lastSent.clear()
  backoffUntil = 0
  if (!newHost) {
    setStatus({ state: 'off' })
    return
  }
  if (!timer) timer = setInterval(() => void tick(), TICK_MS)
  void tick()
}

/**
 * Перед выходом: погасить таймер на кнопках, чтобы Stream Deck не показывал
 * замершее время от закрытой программы. Не дольше `timeoutMs`.
 */
export async function companionGoodbye(timeoutMs = 600): Promise<void> {
  if (!host || status.state !== 'on') return
  if (timer) clearInterval(timer)
  timer = null
  const bye = send(companionOfflineVars()).catch(() => undefined)
  await Promise.race([bye, new Promise((r) => setTimeout(r, timeoutMs))])
}
