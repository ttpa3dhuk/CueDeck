import { app, BrowserWindow, globalShortcut, ipcMain, Menu, protocol, screen, session, shell, systemPreferences } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DONATE_URL } from '../shared/types.js'
import { checkForUpdates } from './updater.js'
import { askBootLayout } from './boot-dialog.js'
import { autoAssignDisplays, defaultLayoutForDisplayCount, type Layout } from './layout.js'
import { applyLayout, getOperatorWindow } from './windows.js'
import { registerIpcHandlers, flushPendingWrites, kindOf, mimeOf, applyClickerShortcuts } from './ipc.js'
import { mediaDirFor } from './pptx-media.js'
import {
  getSavedMapping,
  saveMapping,
  getAskLayoutOnStartup,
  setAskLayoutOnStartup,
  getLastDurationMs,
  getTimerMode,
  getTimerPosition,
  getTimerScale,
  getVideoTakeMode,
  getSlideTakeMode,
  getNotesFontSize,
  getPlaylistCompact,
  getAutoAdvance,
  getAudienceWindowed,
  getAudioOutputId,
  getPreviewAudioOutputId,
  getTimerTickEnabled,
  getTimerGongEnabled,
  getTimerLoop,
  getClickerGlobal,
  getClickerGlobalArrows,
  getSpeakerMsgPresets,
  getTimerPresets,
  getOutputMonitorsEnabled,
  getUiTheme,
} from './display-mapping.js'
import { startOutputMonitor } from './output-monitor.js'
import { store } from './state.js'

export const MEDIA_SCHEME = 'cuedeck-media'

// Must be called before app `ready`. Lets the renderer load the active video
// over a streaming, Range-capable scheme without pulling the whole file into
// memory (unlike images/PDF which go through pdf:read).
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

/**
 * Serves an open video file with HTTP Range support so the <video> element can
 * seek. URL paths:
 *   /program | /preview                — the deck's open video file;
 *   /slide/<deck>/<file>               — ролик, извлечённый из PPTX этого деска
 *                                        (pptx-cache/<sha1>.media/<file>).
 * Only files belonging to the two open decks are ever exposed, so renderers
 * can't read arbitrary files.
 */
async function handleMediaRequest(request: Request): Promise<Response> {
  const state = store.get()
  const segments = new URL(request.url).pathname.split('/').filter(Boolean)

  let filePath: string | null = null
  if (segments[0] === 'slide') {
    // Слайд-видео из PPTX: имя файла строго из manifest'а активного деска.
    const deck = segments[1]
    const file = decodeURIComponent(segments[2] ?? '')
    const d = deck === 'preview' ? state.preview : { kind: state.fileKind, sha1: state.pdfSha1, slideMedia: state.slideMedia }
    if (
      d.kind === 'pptx' &&
      d.sha1 &&
      d.slideMedia.some((m) => m.file === file) &&
      !file.includes('/') &&
      !file.includes('..')
    ) {
      filePath = join(mediaDirFor(d.sha1), file)
    }
  } else {
    const deck = segments[0] // 'program' | 'preview'
    const path = deck === 'preview' ? state.preview.path : state.pdfPath
    const kind = deck === 'preview' ? state.preview.kind : state.fileKind
    if (path && kind === 'video') filePath = path
  }
  if (!filePath) return new Response(null, { status: 404 })

  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    return new Response(null, { status: 404 })
  }

  const type = mimeOf(filePath)
  const rangeHeader = request.headers.get('Range')

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= size) end = size - 1
    if (start > end) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    },
  })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Display Setup…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToOperator('menu:open-display-setup'),
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Новый проект',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToOperator('menu:project-new'),
        },
        {
          label: 'Открыть проект…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendToOperator('menu:project-open'),
        },
        {
          label: 'Сохранить проект',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToOperator('menu:project-save'),
        },
        {
          label: 'Сохранить как…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToOperator('menu:project-save-as'),
        },
        { type: 'separator' },
        {
          label: 'Открыть PDF / PPTX / видео…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToOperator('menu:open-pdf'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Горячие клавиши…',
          accelerator: 'Shift+/',
          click: () => sendToOperator('menu:help'),
        },
        ...(DONATE_URL
          ? ([
              { type: 'separator' },
              {
                label: '☕ Поддержать проект…',
                click: () => shell.openExternal(DONATE_URL).catch(() => undefined),
              },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function sendToOperator(channel: string, ...args: unknown[]): void {
  const op = getOperatorWindow()
  if (op && !op.isDestroyed()) op.webContents.send(channel, ...args)
}


async function bootLayout(): Promise<void> {
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const displayInfo = displays.map((d) => ({ id: d.id, internal: d.id === primaryId }))
  const audienceWindowed = getAudienceWindowed()

  const saved = getSavedMapping()
  let layout = saved?.layout ?? defaultLayoutForDisplayCount(displays.length)

  // macOS does not guarantee identical window placement between launches even
  // for the same display IDs, so a silently restored multi-screen layout can
  // come up scrambled. Ask which mode we're working in (кастомное окно —
  // см. boot-dialog.ts; no app windows exist yet, so it cleanly blocks boot).
  // Esc/Enter = accept the suggested mode. Opt out via the checkbox;
  // re-enable in Display Setup (Cmd+,).
  if (getAskLayoutOnStartup()) {
    const choice = await askBootLayout(displays.length, layout)
    if (choice.layout) layout = choice.layout
    if (choice.dontAsk) setAskLayoutOnStartup(false)
  }

  // Keep manual role→display assignments when the chosen mode matches the
  // one saved for this display topology; otherwise auto-assign.
  const displayMap =
    saved && saved.layout === layout ? saved.displayMap : autoAssignDisplays(layout, displayInfo)
  applyLayout(layout, displayMap, audienceWindowed)
  saveMapping(layout, displayMap)
}

function watchDisplayChanges(): void {
  const onChange = () => sendToOperator('display:topology-changed')
  screen.on('display-added', onChange)
  screen.on('display-removed', onChange)
  screen.on('display-metrics-changed', onChange)
}

app.whenReady().then(async () => {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)

  // Allow microphone/output-device access so enumerateDevices() returns real
  // device labels and <video>.setSinkId() works (routing video sound to a
  // chosen output: sound card / minijack / HDMI to vMix, etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)

  registerIpcHandlers()
  buildMenu()

  /**
   * Живой вход (2.13): без выданного доступа к камере enumerateDevices() отдаёт
   * пустые метки, а getUserMedia падает NotAllowedError. На macOS системный
   * запрос показывается ровно один раз за жизнь приложения — дёргаем его перед
   * открытием списка устройств, а не на старте, чтобы не пугать тех, кому
   * внешний вход не нужен. На Windows/Linux вызов просто отдаёт true.
   */
  ipcMain.handle('live:request-access', async (): Promise<{ camera: boolean; mic: boolean }> => {
    if (process.platform !== 'darwin') return { camera: true, mic: true }
    const camera = await systemPreferences.askForMediaAccess('camera').catch(() => false)
    const mic = await systemPreferences.askForMediaAccess('microphone').catch(() => false)
    return { camera, mic }
  })

  /**
   * Уровень звука эфира: меряет окно, которое реально озвучивает (зал, а в
   * solo — сам оператор), и шлёт сюда; мы пересылаем оператору на индикатор.
   * Через состояние это гнать нельзя — поток чисел 10 раз в секунду.
   */
  ipcMain.on('meter:report', (_e, level: number) => {
    if (typeof level !== 'number' || !Number.isFinite(level)) return
    sendToOperator('meter:program-level', Math.max(0, Math.min(1, level)))
  })

  ipcMain.handle('external:open', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url).catch(() => undefined)
    }
  })

  // Restore preferences (timer settings, UI prefs) — session content loaded on demand via "Последний"
  store.patch({
    timer: { ...store.get().timer, durationMs: getLastDurationMs() },
    timerMode: getTimerMode(),
    timerPosition: getTimerPosition(),
    timerScale: getTimerScale(),
    videoTakeMode: getVideoTakeMode(),
    slideTakeMode: getSlideTakeMode(),
    notesFontSize: getNotesFontSize(),
    playlistCompact: getPlaylistCompact(),
    autoAdvance: getAutoAdvance(),
    audienceWindowed: getAudienceWindowed(),
    audioOutputId: getAudioOutputId(),
    previewAudioOutputId: getPreviewAudioOutputId(),
    timerTickEnabled: getTimerTickEnabled(),
    timerGongEnabled: getTimerGongEnabled(),
    timerLoop: getTimerLoop(),
    speakerMsgPresets: getSpeakerMsgPresets(),
    timerPresets: getTimerPresets(),
    outputMonitorsEnabled: getOutputMonitorsEnabled(),
    uiTheme: getUiTheme(),
    // Re-register the global clicker if it was on; reflect actual success
    // (registration fails when another app holds the keys).
    ...(() => {
      const res = applyClickerShortcuts(getClickerGlobal(), getClickerGlobalArrows())
      return {
        clickerGlobal: res.global,
        // Keep the stored arrows intent visible even while global mode is off.
        clickerGlobalArrows: res.global ? res.arrows : getClickerGlobalArrows(),
      }
    })(),
  })

  await bootLayout()
  watchDisplayChanges()
  startOutputMonitor()

  // Check for updates a few seconds after boot, then daily
  const scheduleUpdateCheck = () => {
    checkForUpdates().then((info) => {
      if (info) sendToOperator('update:available', info)
    })
  }
  setTimeout(scheduleUpdateCheck, 5000)
  setInterval(scheduleUpdateCheck, 24 * 60 * 60 * 1000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void bootLayout()
  })
})

app.on('window-all-closed', async () => {
  await flushPendingWrites()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  e.preventDefault()
  globalShortcut.unregisterAll()
  await flushPendingWrites()
  app.exit(0)
})
