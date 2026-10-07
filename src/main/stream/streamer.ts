import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  StreamDestination,
  StreamDestState,
  StreamDestStatus,
  StreamEncoderConfig,
  StreamEncoderStatus,
  StreamLogEntry,
  StreamReason,
  StreamSettings,
  StreamSide,
  StreamStatus,
} from '../../shared/types.js'
import { t } from '../../shared/i18n.js'
import { fileStamp, logsDir } from '../diag.js'
import { store } from '../state.js'
import { getStreamSettings, sanitizeStreamSettings, setStreamSettings } from '../display-mapping.js'
import {
  acquireGhost,
  createHiddenAudienceWindow,
  ghostWindow,
  releaseGhost,
  createStreamEncoderWindow,
  getActiveWindows,
  getOperatorWindow,
} from '../windows.js'
import { audioFrame, audioSequenceHeader, metaData, videoEndOfSequence, videoFrame, videoSequenceHeader } from './flv.js'
import { parseRtmpUrl, RtmpPublisher } from './rtmp.js'

/**
 * Встроенная трансляция. Устройство:
 *
 *   окно зала ──захват вкладки──▶ скрытое окно-кодировщик (renderer/stream)
 *     WebCodecs: H.264 (аппаратно) + AAC; звук = эфир зала + вход с пульта
 *   ──IPC пакетами──▶ здесь ──FLV/RTMP──▶ до 5 площадок одной и той же копией.
 *
 * Кодируем один раз, поэтому пятая площадка стоит только трафика. Площадка
 * отвалилась — переподключаем её одну, остальные не замечают. Окно зала
 * пересоздаётся при смене раскладки — кодировщик сам перезахватывает его,
 * а пока картинки нет, повторяет последний кадр.
 *
 * Статистика и журнал — как у vMix (просьба Азата): у каждой проблемы пометка,
 * чья сторона — компьютер (кодирование, захват), сеть (очередь растёт, сервер
 * не отвечает) или площадка (закрыла соединение, не приняла ключ).
 */

interface Dest {
  cfg: StreamDestination
  pub: RtmpPublisher | null
  state: StreamDestState
  error: string | null
  errorSide: StreamSide | null
  attempt: number
  reconnects: number
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Заголовки FLV отправлены этому соединению. */
  headersSent: boolean
  /** Метка первого ключевого кадра этого соединения: время на площадке идёт от нуля. */
  base: number | null
  liveSince: number | null
  bytesAtTick: number
  kbps: number
  /** Итоги прошлых соединений: статистика в окне — за всю трансляцию. */
  prevFrames: number
  prevAcked: number
  dropped: number
  droppedAtTick: number
  lastDropAt: number
  /** Сейчас идёт эпизод потерь (для журнала: начало и конец одной строкой). */
  dropping: boolean
  dropEpisodeStart: number
  /** Подряд разрывы сразу после (не)подключения — площадка не держит соединение, не сеть. */
  quickFails: number
  /** Пояснение про «сразу рвёт» уже дано в журнал — не повторять на каждой попытке. */
  warnedFlapping: boolean
}

/** Разрыв быстрее этого после входа в эфир считаем «сразу» — не успела пойти ни секунда картинки. */
const QUICK_FAIL_MS = 3000
const QUICK_FAIL_STREAK = 3

const dests = new Map<string, Dest>()
let enc: BrowserWindow | null = null
let encCfg: StreamEncoderConfig | null = null
/** Сдвиг меток кодировщика относительно старта трансляции, мс. */
let encOffset = 0
let encStatus: StreamEncoderStatus = { state: 'starting', fps: 0, skipped: 0, video: false }
let encSkipping = false
let runStartedAt = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
let encRestartTimer: ReturnType<typeof setTimeout> | null = null
/** Последняя метка, ушедшая в поток: после перезапуска кодировщика время не должно идти назад. */
let lastTs = 0
let journal: StreamLogEntry[] = []
/** Файл журнала текущего/последнего эфира — переживает вылет и перезапуск программы (журнал в памяти при вылете терялся). */
let logPath: string | null = null

const RETRY_MS = [2000, 4000, 8000, 15000]
const LOG_MAX = 200
/** Файлов эфиров хранить в `streams/`: по одному на эфир, старые подчищаются. */
const STREAM_LOG_FILES_KEEP = 30

function settings(): StreamSettings {
  return store.get().stream.settings
}

function patchStream(p: Partial<StreamStatus>): void {
  store.patch({ stream: { ...store.get().stream, ...p } })
}

/** Строка в журнал трансляции (окно оператора), в общий журнал программы и в файл этого эфира. */
function note(level: StreamLogEntry['level'], text: string, side?: StreamSide): void {
  journal = [{ at: Date.now(), level, side, text }, ...journal].slice(0, LOG_MAX)
  const line = `stream: ${side ? `[${side}] ` : ''}${text}`
  if (level === 'info') log.info(line)
  else if (level === 'warn') log.warn(line)
  else log.error(line)
  writeToLogFile(level, side, text)
}

function streamsDir(): string {
  const dir = join(logsDir(), 'streams')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Свой файл на каждый эфир — 200-строчный журнал в памяти теряется при вылете/перезапуске. */
function openLogFile(): void {
  try {
    const dir = streamsDir()
    logPath = join(dir, `stream-${fileStamp(new Date())}.log`)
    const old = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort()
    for (const f of old.slice(0, Math.max(0, old.length - STREAM_LOG_FILES_KEEP + 1))) {
      try {
        unlinkSync(join(dir, f))
      } catch {
        // не критично — подчистим в следующий раз
      }
    }
  } catch (err) {
    logPath = null
    log.warn('stream: не открылась папка журналов эфиров:', err)
  }
}

function writeToLogFile(level: StreamLogEntry['level'], side: StreamSide | undefined, text: string): void {
  if (!logPath) return
  try {
    const tm = new Date().toISOString().replace('T', ' ').slice(0, 23)
    appendFileSync(logPath, `${tm} [${level}]${side ? ` [${side}]` : ''} ${text}\n`, 'utf8')
  } catch (err) {
    // Само сообщение об ошибке файла в файл уже не уйдёт — только в общий журнал.
    log.warn('stream: журнал эфира не записался:', err)
    logPath = null
  }
}

function bytesPerSec(): number {
  const s = settings()
  return ((s.videoKbps + s.audioKbps) * 1000) / 8
}

function maxBacklog(): number {
  // ~2 секунды потока: дольше копить — зрители увидят рывок, а не паузу.
  return Math.round(bytesPerSec() * 2)
}

export function streamSize(height: number): { width: number; height: number } {
  // Ширина по 16:9, чётная — кодеки H.264 требуют.
  const width = Math.round((height * 16) / 9 / 2) * 2
  return { width, height }
}

/**
 * Ошибка соединения → понятный текст и чья сторона. Сетевые коды Node
 * (ENOTFOUND…) — это связь; ответы сервера (закрыл, отказал, не принял ключ) —
 * площадка.
 */
export function explainError(msg: string): { side: StreamSide; text: string } {
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return { side: 'network', text: t('адрес сервера не найден — нет интернета или опечатка в адресе') }
  if (/ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN/.test(msg) || msg === t('Сервер не отвечает')) {
    return { side: 'network', text: t('сервер не отвечает — проверь интернет') }
  }
  if (/ECONNREFUSED/.test(msg)) return { side: 'remote', text: t('сервер не принимает соединение — неверный адрес или порт, либо площадка недоступна') }
  if (/ECONNRESET|EPIPE/.test(msg)) return { side: 'remote', text: t('площадка сбросила соединение') }
  if (/CERT|SSL|TLS|EPROTO/i.test(msg)) return { side: 'network', text: t('ошибка защищённого соединения (RTMPS)') }
  return { side: 'remote', text: msg }
}

// ── площадки ────────────────────────────────────────────────────────────────

function newDest(cfg: StreamDestination): Dest {
  return {
    cfg,
    pub: null,
    state: 'connecting',
    error: null,
    errorSide: null,
    attempt: 0,
    reconnects: 0,
    retryTimer: null,
    headersSent: false,
    base: null,
    liveSince: null,
    bytesAtTick: 0,
    kbps: 0,
    prevFrames: 0,
    prevAcked: 0,
    dropped: 0,
    droppedAtTick: 0,
    lastDropAt: 0,
    dropping: false,
    dropEpisodeStart: 0,
    quickFails: 0,
    warnedFlapping: false,
  }
}

/** Соединение закончилось — его цифры в копилку «за всю трансляцию». */
function retirePublisher(d: Dest, pub: RtmpPublisher): void {
  d.prevFrames += pub.stats.framesSent
  d.prevAcked += pub.stats.acked ?? 0
}

function connectDest(d: Dest): void {
  if (d.retryTimer) clearTimeout(d.retryTimer)
  d.retryTimer = null
  const target = parseRtmpUrl(d.cfg.url, d.cfg.key)
  if (!target) {
    d.state = 'error'
    d.error = destProblem(d.cfg)
    d.errorSide = 'local'
    return
  }
  d.state = d.attempt > 0 ? 'reconnecting' : 'connecting'
  d.headersSent = false
  d.base = null
  const pub = new RtmpPublisher(target)
  d.pub = pub
  d.bytesAtTick = 0
  pub.on('close', (err?: string) => {
    if (d.pub !== pub) return
    d.pub = null
    retirePublisher(d, pub)
    const quick = d.liveSince !== null && Date.now() - d.liveSince < QUICK_FAIL_MS
    d.liveSince = null
    if (!store.get().stream.running) return
    const why = explainError(err ?? t('Соединение закрыто'))
    note('warn', t('{name}: связь оборвалась — {why}', { name: label(d), why: why.text }), why.side)
    noteFlapping(d, quick)
    scheduleRetry(d, why)
  })
  note('info', t('{name}: подключение к {url}', { name: label(d), url: target.tcUrl }))
  pub.connect().then(
    () => {
      if (d.pub !== pub) return
      note('info', t('{name}: в эфире', { name: label(d) }))
      d.state = 'live'
      d.error = null
      d.errorSide = null
      d.attempt = 0
      d.liveSince = Date.now()
      sendHeaders(d)
      requestKeyframe()
      pushStatus()
    },
    (e: Error) => {
      if (d.pub !== pub) return
      d.pub = null
      pub.removeAllListeners()
      pub.close()
      const why = explainError(e.message)
      note('warn', t('{name}: не подключились — {why}', { name: label(d), why: why.text }), why.side)
      noteFlapping(d, true)
      scheduleRetry(d, why)
    },
  )
}

/** Несколько разрывов подряд сразу после подключения — не сеть, а площадка не держит соединение (ключ, завершённый эфир). Один раз, не на каждую попытку. */
function noteFlapping(d: Dest, quick: boolean): void {
  if (!quick) {
    d.quickFails = 0
    d.warnedFlapping = false
    return
  }
  d.quickFails++
  if (d.quickFails >= QUICK_FAIL_STREAK && !d.warnedFlapping) {
    d.warnedFlapping = true
    note('warn', t('{name}: площадка обрывает соединение сразу — похоже, эфир там завершён или ключ сменился', { name: label(d) }), 'remote')
  }
}

function scheduleRetry(d: Dest, why: { side: StreamSide; text: string }): void {
  d.state = 'reconnecting'
  d.error = why.text
  d.errorSide = why.side
  const wait = RETRY_MS[Math.min(d.attempt, RETRY_MS.length - 1)]
  d.attempt++
  d.reconnects++
  d.retryTimer = setTimeout(() => {
    if (store.get().stream.running) connectDest(d)
  }, wait)
  pushStatus()
}

function label(d: Dest): string {
  return d.cfg.name || d.cfg.url
}

function sendHeaders(d: Dest): void {
  if (!d.pub || !encCfg || d.headersSent) return
  const s = settings()
  d.pub.sendMeta(
    metaData({
      width: encCfg.width,
      height: encCfg.height,
      fps: encCfg.fps,
      videoKbps: s.videoKbps,
      audioKbps: s.audioKbps,
      sampleRate: encCfg.sampleRate,
      channels: encCfg.channels,
    }),
  )
  d.pub.sendVideo(0, videoSequenceHeader(Buffer.from(encCfg.avcC)), true, 0, true)
  d.pub.sendAudio(0, audioSequenceHeader(Buffer.from(encCfg.asc)), 0, true)
  d.headersSent = true
}

function onVideo(ts: number, key: boolean, data: Uint8Array): void {
  const runTs = Math.max(lastTs, Math.round(encOffset + ts))
  lastTs = runTs
  let body: Buffer | null = null
  for (const d of dests.values()) {
    if (d.state !== 'live' || !d.pub || !d.headersSent) continue
    if (d.base === null) {
      if (!key) continue
      d.base = runTs
    }
    body ??= videoFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength), key)
    const before = d.pub.stats.dropped
    d.pub.sendVideo(runTs - d.base, body, key, maxBacklog())
    if (d.pub.stats.dropped !== before) {
      d.dropped += d.pub.stats.dropped - before
      d.lastDropAt = Date.now()
    }
  }
}

function onAudio(ts: number, data: Uint8Array): void {
  const runTs = Math.round(encOffset + ts)
  let body: Buffer | null = null
  for (const d of dests.values()) {
    if (d.state !== 'live' || !d.pub || !d.headersSent || d.base === null) continue
    if (runTs < d.base) continue
    body ??= audioFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    d.pub.sendAudio(runTs - d.base, body, maxBacklog())
  }
}

function requestKeyframe(): void {
  if (enc && !enc.isDestroyed()) enc.webContents.send('stream-enc:keyframe')
}

// ── кодировщик и захват ─────────────────────────────────────────────────────

function audienceWindow(): BrowserWindow | null {
  const real = getActiveWindows().get('audience')
  if (real && !real.isDestroyed()) return real
  return ghostWindow('audience')
}

/** В solo зала нет — держим скрытый, пока идёт трансляция; появился настоящий — прячем свой. */
function syncGhost(): void {
  const running = store.get().stream.running
  const real = getActiveWindows().get('audience')
  const need = running && (!real || real.isDestroyed())
  if (need) {
    const { width, height } = streamSize(settings().height)
    acquireGhost('audience', 'stream', () => createHiddenAudienceWindow(width, height))
  } else releaseGhost('audience', 'stream')
}

function startEncoder(): void {
  encCfg = null
  encStatus = { state: 'starting', fps: 0, skipped: 0, video: false }
  enc = createStreamEncoderWindow()
  const w = enc
  w.webContents.on('render-process-gone', (_e, details) => {
    if (enc !== w) return
    note('error', t('кодировщик упал ({reason}) — перезапускаю', { reason: details.reason }), 'local')
    enc = null
    if (!w.isDestroyed()) w.destroy()
    encStatus = { state: 'error', error: t('Кодировщик перезапускается'), fps: 0, skipped: 0, video: false }
    pushStatus()
    if (store.get().stream.running) encRestartTimer = setTimeout(startEncoder, 1500)
  })
}

function stopEncoder(): void {
  if (encRestartTimer) clearTimeout(encRestartTimer)
  encRestartTimer = null
  const w = enc
  enc = null
  encCfg = null
  if (w && !w.isDestroyed()) w.destroy()
}

function isEncoder(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return enc !== null && !enc.isDestroyed() && e.sender === enc.webContents
}

// ── статус ──────────────────────────────────────────────────────────────────

function backlogMs(d: Dest): number {
  return d.pub ? Math.round((d.pub.backlog / bytesPerSec()) * 1000) : 0
}

function reasons(): StreamReason[] {
  const out: StreamReason[] = []
  if (encStatus.state === 'error' && encStatus.error) out.push({ side: 'local', text: encStatus.error })
  if (encStatus.state === 'ok' && !encStatus.video) out.push({ side: 'local', text: t('Нет картинки с окна зала') })
  if (encStatus.skipped > 0) {
    out.push({ side: 'local', text: t('не успевает кодировать: пропущено {n} кадров/с — снизь разрешение или частоту кадров', { n: encStatus.skipped }) })
  }
  if (!dests.size) out.push({ side: 'local', text: t('Нет включённых площадок') })
  const now = Date.now()
  for (const d of dests.values()) {
    if (d.state !== 'live') {
      const text =
        d.state === 'connecting' ? t('подключение…') : `${d.state === 'reconnecting' ? t('переподключение…') : ''} ${d.error ?? ''}`.trim()
      out.push({ side: d.errorSide ?? 'network', text: `${label(d)}: ${text}` })
      continue
    }
    const q = backlogMs(d)
    if (now - d.lastDropAt < 5000) {
      out.push({ side: 'network', text: t('{name}: канал не успевает — очередь {q} с, выбрасываю кадры', { name: label(d), q: (q / 1000).toFixed(1) }) })
    } else if (q > 1000) {
      out.push({ side: 'network', text: t('{name}: копится очередь отправки — {q} с', { name: label(d), q: (q / 1000).toFixed(1) }) })
    }
  }
  return out
}

function pushStatus(): void {
  const s = store.get().stream
  const list: StreamDestStatus[] = [...dests.values()].map((d) => ({
    id: d.cfg.id,
    state: d.state,
    error: d.error,
    kbps: d.kbps,
    dropped: d.dropped,
    framesSent: d.prevFrames + (d.pub?.stats.framesSent ?? 0),
    backlogMs: backlogMs(d),
    ackedMB:
      d.pub?.stats.acked == null && d.prevAcked === 0
        ? null
        : Math.round(((d.prevAcked + (d.pub?.stats.acked ?? 0)) / 1_000_000) * 10) / 10,
    reconnects: d.reconnects,
    liveSince: d.liveSince,
  }))
  const why = s.running ? reasons() : []
  const next: Partial<StreamStatus> = {
    encoder: s.running ? encStatus.state : 'off',
    encoderError: s.running ? (encStatus.error ?? null) : null,
    fps: s.running ? encStatus.fps : 0,
    encoderSkipped: s.running ? encStatus.skipped : 0,
    capture: s.running && encStatus.video,
    destinations: list,
    warn: why.length > 0,
    reasons: why,
    log: journal,
  }
  const cur: Partial<StreamStatus> = {}
  for (const k of Object.keys(next) as (keyof StreamStatus)[]) (cur as Record<string, unknown>)[k] = s[k]
  if (JSON.stringify(cur) !== JSON.stringify(next)) patchStream(next)
}

/** Раз в секунду: скорости, начало/конец эпизодов потерь — в журнал одной строкой. */
function tick(): void {
  syncGhost()
  const now = Date.now()
  for (const d of dests.values()) {
    const bytes = d.pub?.stats.bytesSent ?? 0
    d.kbps = d.state === 'live' ? Math.max(0, Math.round(((bytes - d.bytesAtTick) * 8) / 1000)) : 0
    d.bytesAtTick = bytes
    if (d.dropped > d.droppedAtTick && !d.dropping) {
      d.dropping = true
      d.dropEpisodeStart = d.droppedAtTick
      note('warn', t('{name}: канал не успевает — очередь {q} с, выбрасываю кадры', { name: label(d), q: (backlogMs(d) / 1000).toFixed(1) }), 'network')
    } else if (d.dropping && now - d.lastDropAt > 5000) {
      d.dropping = false
      note('info', t('{name}: канал восстановился, потеряно кадров: {n}', { name: label(d), n: d.dropped - d.dropEpisodeStart }), 'network')
    }
    d.droppedAtTick = d.dropped
  }
  pushStatus()
}

// ── старт / стоп ────────────────────────────────────────────────────────────

export function startStream(): { ok: boolean; error?: string } {
  if (store.get().stream.running) return { ok: true }
  const s = settings()
  const active = activeDestinations()
  if (!active.length) return { ok: false, error: t('Добавь площадку: адрес сервера и ключ') }
  const bad = active.find((d) => !parseRtmpUrl(d.url, d.key))
  if (bad) return { ok: false, error: destProblem(bad) }

  journal = []
  openLogFile()
  const { width, height } = streamSize(s.height)
  note(
    'info',
    t('старт: {w}×{h}, {fps} к/с, видео {v} кбит/с, звук {a} кбит/с, площадок {n}', {
      w: width,
      h: height,
      fps: s.fps,
      v: s.videoKbps,
      a: s.audioKbps,
      n: active.length,
    }),
  )
  runStartedAt = Date.now()
  lastTs = 0
  encSkipping = false
  dests.clear()
  for (const cfg of active) dests.set(cfg.id, newDest(cfg))
  patchStream({ running: true, startedAt: runStartedAt, encoder: 'starting', encoderError: null })
  syncGhost()
  startEncoder()
  for (const d of dests.values()) connectDest(d)
  tickTimer ??= setInterval(tick, 1000)
  pushStatus()
  return { ok: true }
}

export function stopStream(): void {
  if (!store.get().stream.running) return
  const dur = Math.round((Date.now() - runStartedAt) / 1000)
  const lost = [...dests.values()].reduce((n, d) => n + d.dropped, 0)
  note('info', t('стоп: в эфире {min} мин, потеряно кадров: {n}', { min: Math.round(dur / 60), n: lost }))
  // Итог по каждой площадке — в файл эфира, для отправки площадке/заказчику.
  for (const d of dests.values()) {
    const frames = d.prevFrames + (d.pub?.stats.framesSent ?? 0)
    const acked = Math.round(((d.prevAcked + (d.pub?.stats.acked ?? 0)) / 1_000_000) * 10) / 10
    note(
      'info',
      t('итог {name}: кадров {frames}, потеряно {dropped}, переподключений {reconnects}, сервер принял {acked} МБ', {
        name: label(d),
        frames,
        dropped: d.dropped,
        reconnects: d.reconnects,
        acked,
      }),
    )
  }
  patchStream({ running: false, startedAt: null })
  for (const d of dests.values()) closeDest(d)
  dests.clear()
  stopEncoder()
  syncGhost()
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  encStatus = { state: 'starting', fps: 0, skipped: 0, video: false }
  pushStatus()
}

/** Что не так с площадкой, у которой не разбирается адрес: чаще всего — не вставлен ключ. */
function destProblem(d: StreamDestination): string {
  const name = d.name || d.url
  if (/^rtmps?:\/\/[^/]+\/[^/?#]+\/?(\?[^#]*)?$/i.test(d.url.trim()) && !d.key.trim()) {
    return t('«{name}»: нет ключа потока — скопируй его на площадке и вставь в поле «Ключ потока»', { name })
  }
  return t('«{name}»: неверный адрес сервера — нужен rtmp://… или rtmps://…', { name })
}

/** Включённые площадки с адресом — те, куда должна идти трансляция. */
function activeDestinations(): StreamDestination[] {
  return settings().destinations.filter((d) => d.enabled && d.url.trim())
}

/** Закрыть соединение площадки: «конец эфира» ей одной, остальные идут дальше. */
function closeDest(d: Dest): void {
  if (d.retryTimer) clearTimeout(d.retryTimer)
  d.retryTimer = null
  const pub = d.pub
  d.pub = null
  if (pub) {
    if (d.base !== null) pub.sendVideo(Math.max(0, lastTs - d.base), videoEndOfSequence(), true, 0, true)
    pub.removeAllListeners()
    pub.close()
  }
}

/**
 * Площадки во время эфира: оператор снял галку — отключаем одну её, поставил
 * или добавил новую — подключаем сразу (кодировщик общий, новой площадке
 * нужен только ключевой кадр). Сменили адрес/ключ у идущей — переподключаем.
 */
function syncDests(): void {
  if (!store.get().stream.running) return
  const want = new Map(activeDestinations().map((c) => [c.id, c]))
  for (const [id, d] of dests) {
    const cfg = want.get(id)
    if (!cfg) {
      closeDest(d)
      dests.delete(id)
      note('info', t('{name}: отключена оператором, потеряно кадров: {n}', { name: label(d), n: d.dropped }))
    } else if (cfg.url !== d.cfg.url || cfg.key !== d.cfg.key) {
      closeDest(d)
      d.cfg = cfg
      d.attempt = 0
      note('info', t('{name}: адрес или ключ изменён — переподключаю', { name: label(d) }))
      connectDest(d)
    } else {
      d.cfg = cfg
    }
  }
  for (const [id, cfg] of want) {
    if (dests.has(id)) continue
    const d = newDest(cfg)
    dests.set(id, d)
    note('info', t('{name}: добавлена в трансляцию', { name: label(d) }))
    connectDest(d)
  }
  pushStatus()
}

/** «Сохранить…» в окне трансляции: журнал текущего или последнего эфира → рабочий стол. */
async function saveLog(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  let src = logPath
  if (!src) {
    try {
      const dir = streamsDir()
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .sort()
      src = files.length ? join(dir, files[files.length - 1]) : null
    } catch {
      src = null
    }
  }
  if (!src || !existsSync(src)) return { ok: false, error: t('Ещё не было ни одного эфира') }
  try {
    const out = join(app.getPath('desktop'), `CueDeck-${src.split(/[/\\]/).pop()}`)
    await copyFile(src, out)
    shell.showItemInFolder(out)
    return { ok: true, path: out }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function toggleStream(): { ok: boolean; error?: string } {
  if (store.get().stream.running) {
    stopStream()
    return { ok: true }
  }
  return startStream()
}

// ── регистрация ─────────────────────────────────────────────────────────────

export function initStream(): void {
  const s = getStreamSettings()
  patchStream({ settings: s })

  // Захват окна зала: getDisplayMedia кодировщика получает вкладку зала целиком —
  // и картинку, и её звук. enableLocalEcho — зал продолжает звучать в колонках.
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const aud = audienceWindow()
    const fromEncoder =
      enc !== null && !enc.isDestroyed() && req.frame !== null && req.frame.processId === enc.webContents.getProcessId()
    if (!fromEncoder || !aud) {
      cb({})
      return
    }
    cb({ video: aud.webContents.mainFrame, audio: aud.webContents.mainFrame, enableLocalEcho: true })
  })

  ipcMain.handle('stream:set-settings', (_e, patch: Partial<StreamSettings>) => {
    const next = sanitizeStreamSettings({ ...settings(), ...(patch ?? {}) })
    setStreamSettings(next)
    patchStream({ settings: next })
    if (enc && !enc.isDestroyed()) enc.webContents.send('stream-enc:settings', next)
    syncDests()
    return next
  })
  ipcMain.handle('stream:start', () => startStream())
  ipcMain.handle('stream:stop', () => stopStream())
  ipcMain.handle('stream:toggle', () => toggleStream())
  ipcMain.handle('stream:save-log', () => saveLog())

  ipcMain.handle('stream-enc:init', (e) => (isEncoder(e) ? settings() : null))
  ipcMain.on('stream-enc:config', (e, cfg: StreamEncoderConfig) => {
    if (!isEncoder(e)) return
    encCfg = cfg
    // Метки кодировщика — от его собственного старта; переводим во время трансляции.
    encOffset = Math.max(0, cfg.t0 - runStartedAt)
    note('info', t('кодировщик готов: H.264 {w}×{h}, AAC {sr} Гц', { w: cfg.width, h: cfg.height, sr: cfg.sampleRate }), 'local')
    for (const d of dests.values()) {
      d.headersSent = false
      d.base = null
      sendHeaders(d)
    }
  })
  ipcMain.on('stream-enc:video', (e, ts: number, key: boolean, data: Uint8Array) => {
    if (isEncoder(e)) onVideo(ts, key, data)
  })
  ipcMain.on('stream-enc:audio', (e, ts: number, data: Uint8Array) => {
    if (isEncoder(e)) onAudio(ts, data)
  })
  ipcMain.on('stream-enc:status', (e, st: StreamEncoderStatus) => {
    if (!isEncoder(e)) return
    if (st.state === 'error' && st.error && st.error !== encStatus.error) note('error', t('кодировщик: {error}', { error: st.error }), 'local')
    if (st.state === 'ok' && st.video !== encStatus.video) {
      if (st.video) note('info', t('окно зала захвачено'), 'local')
      else note('warn', t('нет картинки с окна зала — перезахват'), 'local')
    }
    if (st.skipped > 0 && !encSkipping) {
      encSkipping = true
      note('warn', t('не успевает кодировать: пропущено {n} кадров/с — снизь разрешение или частоту кадров', { n: st.skipped }), 'local')
    } else if (st.skipped === 0 && encSkipping) {
      encSkipping = false
      note('info', t('кодирование снова успевает'), 'local')
    }
    encStatus = st
    pushStatus()
  })
  ipcMain.on('stream-enc:level', (e, level: [number, number]) => {
    if (!isEncoder(e)) return
    const op = getOperatorWindow()
    if (op && !op.isDestroyed()) op.webContents.send('stream:level', level)
  })
}

/** Выход из программы — вежливо закрыть соединения. */
export function shutdownStream(): void {
  stopStream()
}

