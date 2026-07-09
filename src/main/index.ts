import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, protocol, screen, session, shell } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { checkForUpdates } from './updater.js'
import { autoAssignDisplays, defaultLayoutForDisplayCount, type Layout } from './layout.js'
import { applyLayout, getOperatorWindow } from './windows.js'
import { registerIpcHandlers, flushPendingWrites, kindOf, mimeOf, applyClickerShortcuts } from './ipc.js'
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
  getNotesFontSize,
  getPlaylistCompact,
  getAutoAdvance,
  getAudienceWindowed,
  getAudioOutputId,
  getTimerTickEnabled,
  getTimerGongEnabled,
  getTimerLoop,
  getClickerGlobal,
  getClickerGlobalArrows,
} from './display-mapping.js'
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
 * seek. The URL path selects which deck (`/program` = audience feed, `/preview`
 * = operator staging); only those two open videos are ever exposed, so renderers
 * can't read arbitrary files.
 */
async function handleMediaRequest(request: Request): Promise<Response> {
  const state = store.get()
  const deck = new URL(request.url).pathname.replace(/^\//, '') // 'program' | 'preview'
  const filePath = deck === 'preview' ? state.preview.path : state.pdfPath
  const kind = deck === 'preview' ? state.preview.kind : state.fileKind
  if (!filePath || kind !== 'video') return new Response(null, { status: 404 })

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
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function sendToOperator(channel: string, ...args: unknown[]): void {
  const op = getOperatorWindow()
  if (op && !op.isDestroyed()) op.webContents.send(channel, ...args)
}


const LAYOUT_CHOICES: { layout: Layout; label: string }[] = [
  { layout: 'solo', label: '1 экран (только я)' },
  { layout: 'presenter-audience', label: '2 экрана (ноут + проектор)' },
  { layout: 'operator-speaker-audience', label: '3 экрана (+ суфлёр)' },
]

async function bootLayout(): Promise<void> {
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const displayInfo = displays.map((d) => ({ id: d.id, internal: d.id === primaryId }))
  const audienceWindowed = getAudienceWindowed()

  const saved = getSavedMapping()
  let layout = saved?.layout ?? defaultLayoutForDisplayCount(displays.length)

  // macOS does not guarantee identical window placement between launches even
  // for the same display IDs, so a silently restored multi-screen layout can
  // come up scrambled. Ask which mode we're working in (native dialog — no
  // windows exist yet, so it cleanly blocks boot). Opt out via the checkbox;
  // re-enable in Display Setup (Cmd+,).
  if (getAskLayoutOnStartup()) {
    const defaultId = Math.max(0, LAYOUT_CHOICES.findIndex((c) => c.layout === layout))
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      title: 'CueDeck',
      message: 'В каком режиме работаем?',
      detail: `Сейчас подключено экранов: ${displays.length}.`,
      buttons: LAYOUT_CHOICES.map((c) => c.label),
      defaultId,
      cancelId: defaultId, // Esc = accept the suggested mode
      noLink: true,
      checkboxLabel: 'Больше не спрашивать при запуске',
      checkboxChecked: false,
    })
    layout = LAYOUT_CHOICES[response]?.layout ?? layout
    if (checkboxChecked) setAskLayoutOnStartup(false)
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
    notesFontSize: getNotesFontSize(),
    playlistCompact: getPlaylistCompact(),
    autoAdvance: getAutoAdvance(),
    audienceWindowed: getAudienceWindowed(),
    audioOutputId: getAudioOutputId(),
    timerTickEnabled: getTimerTickEnabled(),
    timerGongEnabled: getTimerGongEnabled(),
    timerLoop: getTimerLoop(),
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
