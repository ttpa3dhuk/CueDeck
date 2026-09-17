import { app, BrowserWindow, ipcMain, screen, shell, type WebContents } from 'electron'
import log from 'electron-log/main'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import os from 'node:os'
import { deflateRawSync } from 'node:zlib'
import type { AppState, DiagInfo, DiagMarker, ReportResult } from '../shared/types.js'
import { WINDOW_TITLES } from '../shared/window-titles.js'
import { dumpPrefs, getCleanExit, setCleanExit } from './display-mapping.js'
import { store } from './state.js'
import { getActiveWindows, getOperatorWindow } from './windows.js'

/**
 * Диагностика: журнал в файл + отчёт о проблеме, который тестер присылает
 * руками (zip на рабочем столе). Автоотправки нет — на площадке интернета
 * может не быть, а лишний сервис тащить пока не за чем.
 *
 * Что попадает в журнал (electron-log, `~/Library/Logs/CueDeck/main.log` на
 * маке, `%APPDATA%\CueDeck\logs\main.log` на Windows, ротация по 5 МБ):
 * - каждое действие оператора — все `ipcMain.handle` обёрнуты в
 *   `instrumentIpc()`, лог «канал + аргументы», ошибка результата, долгие
 *   вызовы. Одна обёртка вместо правки 90+ хендлеров: новые каналы попадают
 *   в журнал сами;
 * - изменения состояния по белому списку ключей (эфир, слайд, раскладка…) —
 *   видно, что произошло внутри после нажатия;
 * - ошибки/варнинги консоли всех окон (`console-message`), падения
 *   рендереров и дочерних процессов (electron-log eventLogger), необработанные
 *   исключения main (errorHandler, без системного диалога — молча в журнал);
 * - жизнь окон и дисплеев, маркеры оператора (⚑), старт/финиш сессии.
 *
 * Флаг `cleanExit` в настройках: false на старте, true перед `app.exit`.
 * Запуск с false = прошлая сессия оборвалась — оператору показывается баннер
 * с подсказкой собрать отчёт.
 *
 * Правило 5 (ничего на зал/суфлёр): всё UI здесь адресовано только окну
 * оператора (`getOperatorWindow`), скриншоты снимаются `capturePage` — на
 * экранах это не видно.
 */

export { log }

const LOG_MAX_BYTES = 5 * 1024 * 1024
/** Меню и хоткей могут сработать оба на одно нажатие — второй маркер глушим. */
const MARK_DEBOUNCE_MS = 400
const CAPTURE_TIMEOUT_MS = 3000
const SCREENSHOT_MAX_WIDTH = 1280

const markers: DiagMarker[] = []
let lastMarkAt = 0
let abnormalPrevious = false

// ── Инициализация ─────────────────────────────────────────────────────────────

/** Вызывать первым делом в index.ts — до `app.whenReady()`. */
export function initDiag(): void {
  log.transports.file.maxSize = LOG_MAX_BYTES
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}'

  // Необработанное исключение в main: раньше Electron показывал системный
  // диалог «A JavaScript error occurred» — посреди шоу он только мешает.
  // Пишем в журнал и живём дальше.
  log.errorHandler.startCatching({ showDialog: false })
  // render-process-gone / child-process-gone / did-fail-load / preload-error /
  // unresponsive — как есть, уровень error.
  log.eventLogger.startLogging({ level: 'error' })

  // В dev каждый рестарт (electron-vite, Ctrl+C) — это kill без штатного
  // выхода: сигналы до Node-обработчиков в main-процессе Electron не доходят,
  // поэтому флаг ведём только у собранного приложения. Иначе баннер «закрылся
  // аварийно» висел бы после каждого перезапуска в разработке.
  if (app.isPackaged) {
    abnormalPrevious = getCleanExit() === false
    setCleanExit(false)
  }

  log.info(
    `═══ CueDeck ${app.getVersion()} старт · ${process.platform} ${os.release()} ${process.arch} · ` +
      `electron ${process.versions.electron} · chrome ${process.versions.chrome} · ` +
      `${app.isPackaged ? 'packaged' : 'dev'} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  )
  if (abnormalPrevious) log.warn('прошлая сессия завершилась НЕ штатно (нет флага cleanExit)')

  app.on('web-contents-created', (_e, wc) => {
    // Уровни Chromium: 0 verbose, 1 info, 2 warning, 3 error. Сюда попадают и
    // необработанные исключения рендереров («Uncaught …») — отдельный
    // перехват в preload не нужен.
    wc.on('console-message', (_ev, level, message, line, sourceId) => {
      if (level < 2) return
      const text = `[${roleOf(wc)}] ${message} (${basename(sourceId)}:${line})`
      if (level === 3) log.error(text)
      else log.warn(text)
    })
  })
  app.on('browser-window-created', (_e, win) => {
    // В момент события заголовок из опций конструктора ещё не применён.
    setTimeout(() => {
      if (win.isDestroyed()) return
      const title = win.getTitle() || '(без имени)'
      log.info(`окно создано: ${title}`)
      win.on('closed', () => log.info(`окно закрыто: ${title}`))
    }, 0)
  })

  app.whenReady().then(() => {
    log.info(`дисплеи: ${describeDisplays()}`)
    screen.on('display-added', () => log.warn(`display-added: ${describeDisplays()}`))
    screen.on('display-removed', () => log.warn(`display-removed: ${describeDisplays()}`))
    screen.on('display-metrics-changed', (_e, _d, metrics) =>
      log.warn(`display-metrics-changed (${metrics.join(',')}): ${describeDisplays()}`),
    )
    watchState()
  })
}

/** Ставится перед `app.exit(0)` в quit-guard — единственная штатная дверь. */
export function markCleanExit(): void {
  log.info('═══ штатный выход')
  if (app.isPackaged) setCleanExit(true)
}

function describeDisplays(): string {
  const primary = screen.getPrimaryDisplay().id
  return screen
    .getAllDisplays()
    .map((d) => `${d.id}:${d.size.width}x${d.size.height}@${d.scaleFactor}${d.id === primary ? '*' : ''}`)
    .join(' ')
}

function roleOf(wc: WebContents): string {
  const win = BrowserWindow.fromWebContents(wc)
  const title = win?.getTitle() ?? ''
  for (const [role, t] of Object.entries(WINDOW_TITLES)) if (t === title) return role
  return title || 'wc'
}

// ── Журнал действий: обёртка над ipcMain.handle ───────────────────────────────

/** Read-only каналы и опросы — действиями не являются, в журнал не идут. */
const QUIET_CHANNELS = new Set([
  'pdf:read',
  'preview:read',
  'keyvisual:read',
  'state:get',
  'displays:list',
  'sidecar:path',
  'soffice:check',
  'soffice:paths',
  'session:has-last',
  'layout:get-ask-on-startup',
  'diag:info',
])
/** Каналы с системным диалогом: их длительность — время раздумий оператора, не тормоза. */
const DIALOG_CHANNELS = new Set([
  'pdf:open-dialog',
  'preview:open-dialog',
  'playlist:add',
  'playlist:add-list',
  'playlist:add-to-list',
  'playlist:relocate',
  'playlist:relink-folder',
  'keyvisual:set',
  'soffice:pick',
  'project:open',
  'project:save',
  'project:consolidate',
])
const SLOW_MS = 1000

/**
 * Вызывать до `registerIpcHandlers()`: подменяет `ipcMain.handle`, чтобы
 * каждый invoke из рендерера оставлял строку в журнале. Поведение хендлеров
 * не меняется (invoke и так ждёт промис).
 */
export function instrumentIpc(): void {
  const original = ipcMain.handle.bind(ipcMain)
  const wrapped: typeof ipcMain.handle = (channel, listener) =>
    original(channel, async (event, ...args) => {
      const quiet = QUIET_CHANNELS.has(channel)
      if (!quiet) log.info(`ipc ${channel}${describeArgs(channel, args)}`)
      const t0 = performance.now()
      try {
        const result = await listener(event, ...args)
        const ms = Math.round(performance.now() - t0)
        const failure = failureOf(result)
        if (failure) log.warn(`ipc ${channel} → ошибка: ${failure} (${ms} мс)`)
        else if (!quiet && ms > SLOW_MS && !DIALOG_CHANNELS.has(channel)) log.info(`ipc ${channel} → ${ms} мс`)
        return result
      } catch (err) {
        log.error(`ipc ${channel} упал:`, err)
        throw err
      }
    })
  ipcMain.handle = wrapped
}

/** `{ ok:false, error }` и просто `{ error }` — стандартные ответы ipc.ts. */
function failureOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { ok?: unknown; error?: unknown; cancelled?: unknown }
  if (r.cancelled) return null
  if (typeof r.error === 'string' && r.error) return r.error
  if (r.ok === false) return 'ok=false'
  return null
}

function describeArgs(channel: string, args: unknown[]): string {
  if (args.length === 0) return ''
  // Текст заметок спикера в журнал не пишем — только адрес и объём.
  if (channel === 'note:update') {
    const p = args[0] as { slide?: number; text?: string } | undefined
    return ` slide=${p?.slide} len=${p?.text?.length ?? 0}`
  }
  return ' ' + args.map(describeValue).join(' ')
}

function describeValue(v: unknown): string {
  if (v == null) return String(v)
  if (typeof v === 'string') return JSON.stringify(truncate(v, 160))
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`
  try {
    return truncate(JSON.stringify(v), 300)
  } catch {
    return '[object]'
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s
}

// ── Журнал состояния: белый список ключей ─────────────────────────────────────

type Projection = Record<string, unknown>

/** Что из AppState интересно в журнале. Плоские ключи + пара вложенных. */
function project(s: AppState): Projection {
  return {
    pdfPath: s.pdfPath,
    fileKind: s.fileKind,
    totalSlides: s.totalSlides,
    currentSlide: s.currentSlide,
    'video.playing': s.video.playing,
    'preview.path': s.preview.path,
    'preview.kind': s.preview.kind,
    'preview.currentSlide': s.preview.currentSlide,
    blackout: s.blackout,
    'timer.running': s.timer.running,
    layout: s.layout,
    displayMap: s.displayMap,
    audienceWindowed: s.audienceWindowed,
    keyVisualPath: s.keyVisualPath,
    projectPath: s.projectPath,
    'playlist.length': s.playlist.length,
    currentPlaylistId: s.currentPlaylistId,
    listIndex: s.listIndex,
    missingIds: s.missingIds,
    audioOutputId: s.audioOutputId,
    speakerMessage: s.speakerMessage,
    autoAdvance: s.autoAdvance,
    videoLoop: s.videoLoop,
    clickerGlobal: s.clickerGlobal,
  }
}

function watchState(): void {
  let prev = project(store.get())
  store.onChange((state) => {
    const next = project(state)
    const changed: string[] = []
    for (const key of Object.keys(next)) {
      const a = prev[key]
      const b = next[key]
      const same = typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b
      if (!same) changed.push(`${key}=${describeValue(b)}`)
    }
    prev = next
    if (changed.length) log.info(`state ${changed.join(' ')}`)
  })
}

// ── Маркеры и отчёт ───────────────────────────────────────────────────────────

/** Оператор нажал «здесь что-то не то». Возвращает номер маркера или null, если это дубль. */
export function markMoment(source: 'hotkey' | 'menu'): number | null {
  const now = Date.now()
  if (now - lastMarkAt < MARK_DEBOUNCE_MS) return null
  lastMarkAt = now
  const marker: DiagMarker = { n: markers.length + 1, at: new Date(now).toLocaleTimeString('ru-RU') }
  markers.push(marker)
  log.warn(`⚑ МАРКЕР #${marker.n} (${source}) — оператор отметил момент`)
  getOperatorWindow()?.webContents.send('diag:marked', marker.n)
  return marker.n
}

export function openReportDialog(): void {
  getOperatorWindow()?.webContents.send('menu:report')
}

function logFilePath(): string {
  return log.transports.file.getFile().path
}

function diagInfo(): DiagInfo {
  return { abnormalPrevious, markers: [...markers], logPath: logFilePath() }
}

/** Вызывать после `instrumentIpc()` — чтобы сборка отчёта тоже попала в журнал. */
export function registerDiagIpc(): void {
  // Из рендереров: window.api.diag.log(level, msg, data?) — точечные метки
  // там, где ошибки раньше глотались `.catch(() => undefined)`.
  ipcMain.on('diag:log', (event, role: unknown, level: unknown, message: unknown, data?: unknown) => {
    if (typeof message !== 'string') return
    const tag = `[${typeof role === 'string' ? role : roleOf(event.sender)}] ${message}`
    const extra = data === undefined ? [] : [describeValue(data)]
    if (level === 'error') log.error(tag, ...extra)
    else if (level === 'warn') log.warn(tag, ...extra)
    else log.info(tag, ...extra)
  })
  ipcMain.handle('diag:mark', () => markMoment('hotkey'))
  ipcMain.handle('diag:info', () => diagInfo())
  ipcMain.handle('diag:build-report', (_e, comment: unknown) =>
    buildReport(typeof comment === 'string' ? comment : ''),
  )
  ipcMain.handle('diag:show-in-folder', (_e, path: unknown) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(path)
  })
  ipcMain.handle('diag:open-log-folder', () => shell.openPath(dirname(logFilePath())))
}

/**
 * Собирает zip на рабочий стол: report.txt (окружение + комментарий +
 * маркеры), state.json (заметки заменены длиной), prefs.json, журналы,
 * скриншоты всех окон. Содержимого презентаций в отчёте нет — только пути.
 */
export async function buildReport(comment: string): Promise<ReportResult> {
  const stamp = new Date()
  log.info(`report: сборка отчёта${comment ? ` (комментарий ${comment.length} симв.)` : ''}`)
  const files: { name: string; data: Buffer }[] = []
  const push = (name: string, data: Buffer | string): void => {
    files.push({ name, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data })
  }

  try {
    push('report.txt', reportText(comment, stamp))
    push('state.json', JSON.stringify(redactState(store.get()), null, 2))
    push('prefs.json', JSON.stringify(dumpPrefs(), null, 2))

    const logPath = logFilePath()
    const logDir = dirname(logPath)
    for (const name of [basename(logPath), 'main.old.log']) {
      const p = join(logDir, name)
      if (existsSync(p)) push(name, await readFile(p))
    }

    for (const [role, win] of getActiveWindows()) {
      if (win.isDestroyed()) continue
      try {
        const shot = await withTimeout(win.webContents.capturePage(), CAPTURE_TIMEOUT_MS)
        const scaled = shot.getSize().width > SCREENSHOT_MAX_WIDTH ? shot.resize({ width: SCREENSHOT_MAX_WIDTH }) : shot
        push(`screen-${role}.jpg`, scaled.toJPEG(80))
      } catch (err) {
        log.warn(`report: скриншот ${role} не снялся:`, err)
      }
    }

    const outPath = join(app.getPath('desktop'), `CueDeck-report-${fileStamp(stamp)}.zip`)
    await writeFile(outPath, buildZip(files, stamp))
    log.info(`report: сохранён ${outPath} (${files.length} файлов)`)
    return { ok: true, path: outPath }
  } catch (err) {
    log.error('report: не собрался:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function reportText(comment: string, stamp: Date): string {
  const lines = [
    `CueDeck ${app.getVersion()} — отчёт о проблеме`,
    `Собран: ${stamp.toLocaleString('ru-RU')}`,
    '',
    `ОС: ${process.platform} ${os.release()} ${process.arch} · ${os.cpus()[0]?.model ?? '?'} · RAM ${Math.round(os.totalmem() / 2 ** 30)} ГБ`,
    `Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · Node ${process.versions.node}`,
    `Сборка: ${app.isPackaged ? 'packaged' : 'dev'} · ${app.getPath('exe')}`,
    `Локаль: ${app.getLocale()} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `Аптайм приложения: ${Math.round(process.uptime() / 60)} мин`,
    `Дисплеи: ${describeDisplays()}`,
    `Прошлая сессия завершилась штатно: ${abnormalPrevious ? 'НЕТ' : 'да'}`,
    '',
    '── Комментарий оператора ──',
    comment.trim() || '(нет)',
    '',
    '── Маркеры (⚑ в журнале) ──',
    ...(markers.length ? markers.map((m) => `#${m.n}  ${m.at}`) : ['(нет)']),
    '',
  ]
  return lines.join('\n')
}

/** Текст заметок спикера → длина: в отчёте им делать нечего. */
function redactState(s: AppState): unknown {
  const redactNotes = (notes: Record<number, string>): Record<number, string> =>
    Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, `<${v.length} симв.>`]))
  return {
    ...s,
    notes: redactNotes(s.notes),
    preview: { ...s.preview, notes: redactNotes(s.preview.notes) },
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms} мс`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

// ── Минимальный zip-writer (deflate, без zip64) ───────────────────────────────
// pptx-media.ts умеет только перестраивать чужой zip; писать с нуля проще
// своими 50 строками, чем тащить зависимость.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(files: { name: string; data: Buffer }[], stamp: Date): Buffer {
  const dosTime = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1)
  const dosDate = ((stamp.getFullYear() - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const packed = deflateRawSync(f.data)
    const crc = crc32(f.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: имена в UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, eocd])
}
