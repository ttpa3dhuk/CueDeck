import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// Готовая страница Companion едет внутри приложения — клиенту не нужен репозиторий
// (собирается `npx vite-node companion/build.ts`, см. companion/README.md).
import companionPage from '../../../companion/CueDeck.companionconfig?raw'
import dgram from 'node:dgram'
import http from 'node:http'
import os from 'node:os'
import { log } from '../diag.js'
import { getMidiInputs, getRemoteSettings, setMidiInputs, setRemoteSettings, validHost } from '../display-mapping.js'
import { configureCompanionPush } from './companion-push.js'
import { store, type RemoteSettings, type RemoteStatus } from '../state.js'
import { DEFAULT_REMOTE_SETTINGS } from '../../shared/types.js'
import { elapsedMs, formatMs, remainingMs, timerView } from '../../renderer/shared/timer.js'
import { programHasVideo, resolveRemote, type RemoteArg } from './commands.js'
import { helpPage } from './help-page.js'
import { parseOscPacket } from './osc.js'

/**
 * Внешнее управление (PLAN 2.18): HTTP и OSC слушают в main-процессе, поэтому
 * команда доходит независимо от того, какое окно в фокусе и в фокусе ли
 * CueDeck вообще — Stream Deck работает, пока оператор сидит в браузере.
 *
 * Кто к нам ходит:
 * - родная программа Elgato Stream Deck — действие «Website» с галкой
 *   «GET request in background»: `GET http://127.0.0.1:9420/api/timer/start`;
 * - Bitfocus Companion — модуль Generic HTTP (тот же URL) или Generic OSC
 *   (`/cuedeck/timer/start` на UDP 9421);
 * - grandMA3, QLab, StageCue, TouchOSC — OSC.
 *
 * Исполнение: команда (commands.ts) превращается в вызовы ipc-каналов, и мы
 * зовём **те же обработчики**, что зарегистрировал ipc.ts для кнопок оператора
 * (`captureIpcHandlers` запоминает их при регистрации). Своей логики таймера
 * здесь нет и быть не должно.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

/**
 * Запоминать обработчики ipc по мере регистрации. Вызывать после
 * `instrumentIpc()` и до `registerIpcHandlers()`.
 */
export function captureIpcHandlers(): void {
  const prev = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: Handler) => {
    handlers.set(channel, listener)
    prev(channel, listener)
  }) as typeof ipcMain.handle
}

/** Обработчики из ipc.ts event не трогают; окна-отправителя у нас нет. */
const REMOTE_EVENT = { sender: null, frameId: -1, processId: -1 } as unknown as IpcMainInvokeEvent

// Команды исполняются строго по очереди: «restart» = reset + start, а toggle
// должен видеть состояние после предыдущего нажатия, даже если Stream Deck
// прислал два запроса подряд.
let queue: Promise<unknown> = Promise.resolve()

interface ExecResult {
  ok: boolean
  command?: string
  error?: string
  ignored?: boolean
}

function execute(source: string, segments: string[], extra: RemoteArg[]): Promise<ExecResult> {
  const run = async (): Promise<ExecResult> => {
    const r = resolveRemote(segments, extra, store.get())
    if (!r.ok) {
      log.warn(`remote ${source} ${segments.join('/')}: ${r.error}`)
      return { ok: false, error: r.error }
    }
    if ('ignored' in r) return { ok: true, command: r.command, ignored: true }
    log.info(`remote ${source} ${r.command}${extra.length ? ' ' + JSON.stringify(extra) : ''}`)
    for (const c of r.calls) {
      const h = handlers.get(c.channel)
      if (!h) {
        log.error(`remote: нет обработчика ${c.channel}`)
        return { ok: false, command: r.command, error: `внутренняя ошибка: нет ${c.channel}` }
      }
      // Обработчики ipc.ts отвечают `{ ok:false, error }` (файл не найден,
      // список пуст…) — отдаём это кнопке, иначе Stream Deck покажет «успех».
      const res = (await h(REMOTE_EVENT, ...c.args)) as { ok?: unknown; error?: unknown } | undefined
      if (res && typeof res === 'object' && res.ok === false) {
        const error = typeof res.error === 'string' && res.error ? res.error : `${c.channel} не выполнен`
        log.warn(`remote ${source} ${r.command}: ${error}`)
        return { ok: false, command: r.command, error }
      }
    }
    return { ok: true, command: r.command }
  }
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p.catch((err) => {
    log.error('remote: команда упала', err)
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  })
}

// ── Статус для обратной связи (Companion-переменные, справочная страница) ────

function baseName(p: string | null): string | null {
  if (!p) return null
  return p.split(/[\\/]/).pop() ?? p
}

function entryName(id: string | null, path: string | null): string | null {
  const e = id ? store.get().playlist.find((x) => x.id === id) : undefined
  return e ? e.displayName || e.fileName : baseName(path)
}

/**
 * Снимок для обратной связи на кнопках (Companion сейчас, свой плагин
 * Stream Deck потом — PLAN 2.18 шаг 3): таймер, эфир со слайдами и остатком,
 * ролик, превью, место в плейлисте. Номера записей — с единицы, как на карточках.
 */
function statusJson(): Record<string, unknown> {
  const s = store.get()
  const now = Date.now()
  const view = timerView(s.timer, s.timerMode, now)
  const pos = store.videoPositionSec()
  const dur = s.video.durationSec
  const indexOf = (id: string | null): number | null => {
    const i = id ? s.playlist.findIndex((e) => e.id === id) : -1
    return i >= 0 ? i + 1 : null
  }
  const slides = s.totalSlides > 0
  return {
    ok: true,
    app: 'CueDeck',
    version: app.getVersion(),
    timer: {
      text: view.text,
      color: view.color,
      overtime: view.overtime,
      running: s.timer.running,
      mode: s.timerMode,
      position: s.timerPosition,
      durationMs: s.timer.durationMs,
      durationText: formatMs(s.timer.durationMs),
      elapsedMs: elapsedMs(s.timer, now),
      remainingMs: remainingMs(s.timer, now),
    },
    program: {
      name: entryName(s.currentPlaylistId, s.pdfPath),
      kind: s.fileKind,
      slide: slides ? s.currentSlide : null,
      total: slides ? s.totalSlides : null,
      /** Сколько слайдов ещё впереди (0 — последний). */
      remaining: slides ? Math.max(0, s.totalSlides - s.currentSlide) : null,
      text: slides ? `${s.currentSlide}/${s.totalSlides}` : '',
      blackout: s.blackout,
      playlistIndex: indexOf(s.currentPlaylistId),
    },
    video: {
      active: programHasVideo(s),
      playing: s.video.playing,
      muted: s.video.muted,
      loop: s.videoLoop,
      positionSec: Math.round(pos * 10) / 10,
      durationSec: dur,
      remainingText: dur > 0 ? formatMs(Math.max(0, dur - pos) * 1000) : '',
    },
    preview: {
      name: entryName(s.preview.playlistId, s.preview.path),
      kind: s.preview.kind,
      slide: s.preview.totalSlides > 0 ? s.preview.currentSlide : null,
      total: s.preview.totalSlides > 0 ? s.preview.totalSlides : null,
      playlistIndex: indexOf(s.preview.playlistId),
    },
    playlist: { count: s.playlist.length },
    speakerMessage: s.speakerMessage,
  }
}

/**
 * Короткие текстовые ответы под заголовок кнопки — для тех, кто умеет
 * показать ответ как есть, без разбора JSON.
 */
const TEXT_ENDPOINTS: Record<string, () => string> = {
  '/api/timer/text': () => {
    const s = store.get()
    return timerView(s.timer, s.timerMode).text
  },
  '/api/program/text': () => {
    const s = store.get()
    return s.totalSlides > 0 ? `${s.currentSlide}/${s.totalSlides}` : ''
  },
  '/api/program/remaining': () => {
    const s = store.get()
    return s.totalSlides > 0 ? String(Math.max(0, s.totalSlides - s.currentSlide)) : ''
  },
  '/api/video/remaining': () => {
    const s = store.get()
    const dur = s.video.durationSec
    return dur > 0 && programHasVideo(s) ? formatMs(Math.max(0, dur - store.videoPositionSec()) * 1000) : ''
  },
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
  res.end(body)
}

const json = (res: http.ServerResponse, code: number, obj: unknown): void =>
  send(res, code, 'application/json', JSON.stringify(obj))

/** В режиме «только этот компьютер» чужой Host — это DNS-rebinding из браузера. */
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

async function onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const settings = current
  if (!settings.lan && !LOCAL_HOSTS.test(req.headers.host ?? '')) {
    json(res, 403, { ok: false, error: 'доступ только с этого компьютера' })
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    json(res, 405, { ok: false, error: 'только GET или POST' })
    return
  }
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://x')
  } catch {
    json(res, 400, { ok: false, error: 'кривой адрес' })
    return
  }
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (path === '/') {
    send(res, 200, 'text/html', helpPage(settings, status.hosts))
    return
  }
  if (path === '/favicon.ico') {
    res.writeHead(204).end()
    return
  }
  if (path === '/api/state') {
    json(res, 200, statusJson())
    return
  }
  const text = TEXT_ENDPOINTS[path]
  if (text) {
    send(res, 200, 'text/plain', text())
    return
  }
  if (!path.startsWith('/api/')) {
    json(res, 404, { ok: false, error: 'команды живут под /api/, список — на главной странице' })
    return
  }

  let segments: string[]
  try {
    segments = path.slice(5).split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    json(res, 400, { ok: false, error: 'кривая кодировка в адресе' })
    return
  }
  const value = url.searchParams.get('value')
  const r = await execute('http', segments, value !== null ? [value] : [])
  json(res, r.ok ? 200 : 400, r)
}

// ── OSC ──────────────────────────────────────────────────────────────────────

const OSC_PREFIX = /^\/cuedeck(?=\/|$)/i

function onOsc(msg: Buffer, from: dgram.RemoteInfo): void {
  let messages
  try {
    messages = parseOscPacket(msg)
  } catch (err) {
    log.warn(`remote osc: мусорный пакет от ${from.address}:${from.port} (${msg.length} б)`, String(err))
    return
  }
  for (const m of messages) {
    // Префикс /cuedeck необязателен: `/timer/start` тоже понимаем.
    const segments = m.address.replace(OSC_PREFIX, '').split('/').filter(Boolean)
    void execute('osc', segments, m.args)
  }
}

// ── Жизненный цикл ───────────────────────────────────────────────────────────

let current: RemoteSettings = { ...DEFAULT_REMOTE_SETTINGS }
let status: RemoteStatus = offStatus(current)
let httpServers: http.Server[] = []
let oscSocket: dgram.Socket | null = null

function getRemoteSettingsSafe(): RemoteSettings {
  try {
    return getRemoteSettings()
  } catch {
    return { ...DEFAULT_REMOTE_SETTINGS }
  }
}

function offStatus(s: RemoteSettings): RemoteStatus {
  return {
    ...s,
    http: 'off',
    osc: 'off',
    httpError: null,
    oscError: null,
    hosts: [],
    companion: 'off',
    companionError: null,
  }
}

function humanError(err: NodeJS.ErrnoException, port: number): string {
  if (err.code === 'EADDRINUSE') return `порт ${port} занят другой программой — укажи другой`
  if (err.code === 'EACCES') return `нет прав на порт ${port}`
  if (err.code === 'EADDRNOTAVAIL') return 'сетевой адрес недоступен'
  return err.message
}

function listenHttp(host: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      onHttp(req, res).catch((err) => {
        log.error('remote http упал', err)
        if (!res.headersSent) json(res, 500, { ok: false, error: 'внутренняя ошибка' })
      })
    })
    srv.once('error', reject)
    srv.listen(port, host, () => {
      srv.off('error', reject)
      srv.on('error', (err) => log.error(`remote http ${host}:${port}`, err))
      resolve(srv)
    })
  })
}

function listenOsc(host: string, port: number): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false })
    sock.once('error', reject)
    sock.on('message', onOsc)
    sock.bind(port, host, () => {
      sock.off('error', reject)
      sock.on('error', (err) => log.error(`remote osc ${host}:${port}`, err))
      resolve(sock)
    })
  })
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return out
}

async function stopAll(): Promise<void> {
  const closing = httpServers.map(
    (s) =>
      new Promise<void>((resolve) => {
        s.close(() => resolve())
        s.closeAllConnections()
      }),
  )
  httpServers = []
  if (oscSocket) {
    const s = oscSocket
    oscSocket = null
    closing.push(new Promise<void>((resolve) => s.close(() => resolve())))
  }
  await Promise.all(closing)
}

async function apply(next: RemoteSettings): Promise<RemoteStatus> {
  await stopAll()
  current = next
  const st = offStatus(next)
  if (next.enabled) {
    // IPv4 обязателен; ::1 — вдогонку: иначе клиенты, у которых «localhost»
    // резолвится в IPv6, получали бы «соединение отклонено».
    const v4 = next.lan ? '0.0.0.0' : '127.0.0.1'
    try {
      httpServers.push(await listenHttp(v4, next.httpPort))
      st.http = 'on'
      try {
        httpServers.push(await listenHttp('::1', next.httpPort))
      } catch {
        /* IPv6 выключен в системе — не беда */
      }
    } catch (err) {
      st.http = 'error'
      st.httpError = humanError(err as NodeJS.ErrnoException, next.httpPort)
    }
    try {
      oscSocket = await listenOsc(v4, next.oscPort)
      st.osc = 'on'
    } catch (err) {
      st.osc = 'error'
      st.oscError = humanError(err as NodeJS.ErrnoException, next.oscPort)
    }
    st.hosts = ['127.0.0.1', ...(next.lan ? lanAddresses() : [])]
    log.info(
      `remote: HTTP ${st.http}${st.httpError ? ` (${st.httpError})` : ''} :${next.httpPort}, ` +
        `OSC ${st.osc}${st.oscError ? ` (${st.oscError})` : ''} :${next.oscPort}, ` +
        `${next.lan ? 'из сети' : 'только этот компьютер'}`,
    )
  } else {
    log.info('remote: выключено')
  }
  status = st
  store.patch({ remote: st })
  // Отправка в Companion живёт своим циклом: её статус меняется и без
  // перенастройки (Companion запустили/закрыли) — патчим только его поля.
  configureCompanionPush(next.enabled && next.companionPush ? next.companionHost : null, (c) => {
    status = {
      ...status,
      companion: c.state,
      companionError: c.state === 'error' ? c.error : null,
    }
    store.patch({ remote: status })
  })
  return status
}

function sanitize(v: Partial<RemoteSettings>): RemoteSettings {
  const port = (x: unknown, def: number): number => {
    const n = Math.floor(Number(x))
    return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : def
  }
  return {
    enabled: v.enabled === true,
    httpPort: port(v.httpPort, current.httpPort),
    oscPort: port(v.oscPort, current.oscPort),
    lan: v.lan === true,
    companionPush: v.companionPush !== false,
    companionHost: validHost(v.companionHost) ?? current.companionHost,
  }
}

/** Поднять слушатели по сохранённым настройкам — вызывать после регистрации ipc. */
export async function initRemote(): Promise<void> {
  await apply(getRemoteSettingsSafe())
}

export function registerRemoteIpc(): void {
  ipcMain.handle('remote:configure', async (_e, v: Partial<RemoteSettings>) => {
    const next = sanitize(v ?? {})
    if (next.httpPort === next.oscPort) {
      // Один номер для TCP и UDP технически можно, но путает людей при настройке.
      return { ok: false, error: 'порты HTTP и OSC должны различаться' }
    }
    setRemoteSettings(next)
    return { ok: true, status: await apply(next) }
  })
  ipcMain.handle('remote:save-companion-page', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = {
      title: 'Страница CueDeck для Companion',
      defaultPath: join(app.getPath('desktop'), 'CueDeck.companionconfig'),
      filters: [{ name: 'Companion', extensions: ['companionconfig'] }],
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true }
    await writeFile(res.filePath, companionPage)
    shell.showItemInFolder(res.filePath)
    return { ok: true, path: res.filePath }
  })
  ipcMain.handle('midi:get-enabled', () => getMidiInputs())
  ipcMain.handle('midi:set-enabled', (_e, names: unknown) => {
    setMidiInputs(Array.isArray(names) ? names : [])
  })
  ipcMain.handle('remote:open-help', () => {
    if (status.http !== 'on') return { ok: false, error: 'HTTP не запущен' }
    void shell.openExternal(`http://127.0.0.1:${current.httpPort}/`)
    return { ok: true }
  })
}
