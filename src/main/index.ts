import { app, BrowserWindow, globalShortcut, ipcMain, Menu, protocol, screen, session, shell } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { checkForUpdates } from './updater.js'
import { autoAssignDisplays, defaultLayoutForDisplayCount } from './layout.js'
import { applyLayout, getOperatorWindow } from './windows.js'
import { registerIpcHandlers, flushPendingWrites, kindOf, mimeOf } from './ipc.js'
import {
  getSavedMapping,
  saveMapping,
  getLastDurationMs,
  getTimerMode,
  getTimerPosition,
  getTimerScale,
  getNotesFontSize,
  getPlaylistCompact,
  getAutoAdvance,
  getAudienceWindowed,
  getAudioOutputId,
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
 * Serves the currently-open video file with HTTP Range support so the
 * <video> element can seek. Only the active video (store.pdfPath) is ever
 * exposed — the request URL carries no path, so renderers can't read
 * arbitrary files.
 */
async function handleMediaRequest(request: Request): Promise<Response> {
  const { pdfPath, fileKind } = store.get()
  if (!pdfPath || fileKind !== 'video') return new Response(null, { status: 404 })

  let size: number
  try {
    size = (await stat(pdfPath)).size
  } catch {
    return new Response(null, { status: 404 })
  }

  const type = mimeOf(pdfPath)
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
    const stream = Readable.toWeb(createReadStream(pdfPath, { start, end })) as ReadableStream
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

  const stream = Readable.toWeb(createReadStream(pdfPath)) as ReadableStream
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


function bootLayout(): void {
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const displayInfo = displays.map((d) => ({ id: d.id, internal: d.id === primaryId }))
  const audienceWindowed = getAudienceWindowed()

  const saved = getSavedMapping()
  if (saved) {
    applyLayout(saved.layout, saved.displayMap, audienceWindowed)
    return
  }

  const layout = defaultLayoutForDisplayCount(displays.length)
  const displayMap = autoAssignDisplays(layout, displayInfo)
  applyLayout(layout, displayMap, audienceWindowed)
  saveMapping(layout, displayMap)
}

function registerShortcuts(): void {
  // Most shortcuts handled by renderer via keydown; we only register a few global ones.
  globalShortcut.register('CommandOrControl+,', () => sendToOperator('menu:open-display-setup'))
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
    notesFontSize: getNotesFontSize(),
    playlistCompact: getPlaylistCompact(),
    autoAdvance: getAutoAdvance(),
    audienceWindowed: getAudienceWindowed(),
    audioOutputId: getAudioOutputId(),
  })

  bootLayout()
  registerShortcuts()
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
    if (BrowserWindow.getAllWindows().length === 0) bootLayout()
  })
})

app.on('window-all-closed', async () => {
  await flushPendingWrites()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  e.preventDefault()
  await flushPendingWrites()
  app.exit(0)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
