import { setOperatorApplicationMenu } from './application-menu.js'
import { registerTestScreenIpc } from './test-screen.js'
import { registerAudienceOutputIpc } from './audience-output.js'
import { startupTestScreenAllowed } from '../shared/test-screen.js'
import { app, BrowserWindow, ipcMain, Menu, protocol, screen, session, shell, systemPreferences } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DONATE_URL, SUPPORT_URL } from '../shared/types.js'
import { checkForUpdates } from './updater.js'
import { showAboutDialog } from './about-dialog.js'
import { initDiag, instrumentIpc, markCleanExit, markMoment, openReportDialog, registerDiagIpc } from './diag.js'
import { isMovingToApplications, offerMacInstall } from './mac-install.js'
import { captureIpcHandlers, initRemote, registerRemoteIpc } from './remote/server.js'
import { registerWindowCapture } from './window-capture.js'
import { initStream } from './stream/streamer.js'
import { initOmt, registerOmtIpc } from './omt/outputs.js'
import { initSyphonBridge } from './syphon-bridge.js'
import { initSyphonGpuProbe } from './syphon-gpu-probe.js'
import { initSyphonGpuAudience } from './syphon-gpu-audience.js'
import { initLoopProbe } from './loop-probe.js'
import { registerOmtInputIpc } from './omt/input-ipc.js'
import { registerProfileIpc } from './profiles.js'
import { askBootLayout } from './boot-dialog.js'
import { askUiLang } from './lang-dialog.js'
import { DEFAULT_LANG, setLang, t } from '../shared/i18n.js'
import { showNagDialog } from './nag-dialog.js'
import { attachOperatorCloseGuard, requestQuit } from './quit-guard.js'
import { autoAssignDisplays, defaultLayoutForDisplayCount, type Layout } from './layout.js'
import { applyLayout, getOperatorWindow, reloadAllWindowsForLang, setOperatorWindowHook } from './windows.js'
import { registerIpcHandlers, flushPendingWrites, kindOf, mimeOf, applyClickerShortcuts, suspendClickerShortcuts } from './ipc.js'
import { programMirrorEnabled, registerProgramMirrorIpc } from './program-mirror.js'
import { mediaDirFor } from './pptx-media.js'
import { ProgramMediaLeases } from './program-media-leases.js'
import { configureCompositor } from './compositor.js'
import {
  getSavedMapping,
  getPlaylist,
  getLastPdfPath,
  getProjectPath,
  getKeyVisualPath,
  saveMapping,
  getAskLayoutOnStartup,
  setAskLayoutOnStartup,
  getLastDurationMs,
  getMaterialSettings,
  getAudienceTimer,
  getTimerMode,
  getTimerPosition,
  getTimerScale,
  getTimerFree,
  getTimerFont,
  getTimerColor,
  getTimerWarnColors,
  getSpeakerToolbarScale,
  getSpeakerLayout,
  getSpeakerMsgLayout,
  getVideoTakeMode,
  getSlideTakeMode,
  getTakeFadeMs,
  getNotesFontSize,
  getPlaylistCompact,
  getAutoAdvance,
  getAudienceWindowed,
  getAudienceAlwaysOnTop,
  getAudioOutputId,
  getPreviewAudioOutputId,
  getTimerTickEnabled,
  getTimerGongEnabled,
  getTimerLoop,
  getPlaylistDoubleClickTake,
  getClickerGlobal,
  getClickerGlobalArrows,
  getSpeakerMsgPresets,
  getTimerPresets,
  getTimerAdjustments,
  getOutputMonitorsEnabled,
  getUiTheme,
  getUiLang,
  setUiLang,
  getLastLaunchAt,
  setLastLaunchAt,
} from './display-mapping.js'
import { startOutputMonitor } from './output-monitor.js'
import { store } from './state.js'
import { createAudienceTimer } from '../shared/audience-timer.js'

export const MEDIA_SCHEME = 'cuedeck-media'

// Журнал и перехват ошибок — раньше всего остального, чтобы падение на старте
// тоже оставило след (diag.ts).
initDiag()
configureCompositor(process.platform, app.commandLine)

const outgoingMedia = new ProgramMediaLeases((sha1, file) => join(mediaDirFor(sha1), file))
let previousMediaState = store.get()
store.onChange((state, patch) => {
  if (patch.takeTransition && patch.takeTransition.durationMs > 0) outgoingMedia.retain(previousMediaState)
  previousMediaState = state
})

// Must be called before app `ready`. Lets the renderer load the active video
// over a streaming, Range-capable scheme without pulling the whole file into
// memory (unlike images/PDF which go through pdf:read).
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: programMirrorEnabled },
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
  const corsHeaders: Record<string, string> = programMirrorEnabled ? {
    'Access-Control-Allow-Origin': process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin : 'null',
  } : {}
  const state = store.get()
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const token = url.searchParams.get('v')

  let filePath: string | null = null
  if (token && token !== state.pdfSha1 &&
    ((segments[0] === 'program' && segments.length === 1) ||
      (segments[0] === 'slide' && segments[1] === 'program' && segments.length === 3))) {
    let file: string | undefined
    try { file = segments[0] === 'slide' ? decodeURIComponent(segments[2]) : undefined }
    catch { return new Response(null, { status: 404 }) }
    filePath = outgoingMedia.resolve(token, file)
  } else if (segments[0] === 'keyvisual') {
    // Видео-заставка (анимированный KV): отдаём тем же Range-потоком, что и
    // ролики плейлиста — файл может быть тяжёлым, в память его не тянем.
    const kv = state.keyVisualPath
    if (kv && kindOf(kv) === 'video') filePath = kv
  } else if (segments[0] === 'slide') {
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
        ...corsHeaders,
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
      ...corsHeaders,
    },
  })
}

let menuAudioOutputs: { id: string; label: string }[] = []

function quickMenus(): Electron.MenuItemConstructorOptions[] {
  const state = store.get()
  const command = (action: string, value: unknown) => sendToOperator('menu:quick-setting', action, value)
  const displays = screen.getAllDisplays()
  const layouts = [
    ['solo', t('1 экран (только я)')],
    ['presenter-audience', t('2 экрана (ноут + проектор)')],
    ['operator-speaker-audience', t('3 экрана (+ суфлёр клиента)')],
  ] as const
  const audioMenu = (preview: boolean): Electron.MenuItemConstructorOptions[] => {
    const current = preview ? state.previewAudioOutputId : state.audioOutputId
    const choices = [{ id: null, label: preview ? t('Выключена (превью без звука)') : t('Системный выход по умолчанию') }, ...menuAudioOutputs]
    if (current && !choices.some(d => d.id === current)) choices.push({ id: current, label: t('Устройство недоступно') })
    return choices.map(d => ({ label: d.label, type: 'radio', checked: (current ?? null) === d.id,
      enabled: d.id === null || menuAudioOutputs.some(output => output.id === d.id),
      click: () => command(preview ? 'previewAudio' : 'audio', d.id) }))
  }
  return [
    { label: t('Экраны'), submenu: [
      { label: t('Режим работы'), submenu: layouts.map(([value, label]) => ({ label, type: 'radio', checked: state.layout === value, click: () => command('layout', value) })) },
      ...(['operator', 'audience', 'speaker'] as const).map(role => ({
        label: role === 'operator' ? t('Оператор') : role === 'audience' ? t('Зал') : t('Суфлёр'),
        enabled: role === 'operator' || (role === 'audience' ? state.layout !== 'solo' : state.layout === 'operator-speaker-audience'),
        submenu: displays.map((d, i) => ({ label: `${d.label || `Display ${i + 1}`} — ${d.size.width}×${d.size.height}`, type: 'radio' as const,
          checked: state.displayMap[role] === d.id, click: () => command('display', { role, id: d.id }) })),
      })),
      { type: 'separator' },
      { label: t('Вывод зала'), type: 'checkbox', checked: state.layout !== 'solo' && state.audienceOutputEnabled,
        enabled: state.layout !== 'solo', click: item => command('audienceOutput', item.checked) },
      { label: t('Аудитория в окне'), type: 'checkbox', checked: state.audienceWindowed, click: item => command('audienceWindowed', item.checked) },
      { label: t('Тестовый экран'), type: 'checkbox', checked: state.testScreen.manual || state.testScreen.automatic, click: item => command('testScreen', item.checked) },
      { label: t('Монитор суфлёра под эфиром'), type: 'checkbox', checked: state.outputMonitorsEnabled, click: item => command('monitor', item.checked) },
      { type: 'separator' },
      { label: t('Настройки экранов…'), click: () => sendToOperator('menu:open-display-setup') },
    ] },
    { label: t('Звук'), submenu: [
      { label: t('Эфир'), submenu: audioMenu(false) },
      { label: t('Предпрослушка'), submenu: audioMenu(true) },
    ] },
  ]
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: 'CueDeck',
            submenu: [
              { label: t('О CueDeck'), click: () => void showAboutDialog() },
              { type: 'separator' },
              {
                label: t('Настройки…'),
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToOperator('menu:open-settings'),
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
          label: t('Новый проект'),
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToOperator('menu:project-new'),
        },
        {
          label: t('Открыть проект…'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendToOperator('menu:project-open'),
        },
        {
          label: t('Сохранить проект'),
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToOperator('menu:project-save'),
        },
        {
          label: t('Сохранить как…'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToOperator('menu:project-save-as'),
        },
        {
          label: t('Собрать проект в папку…'),
          click: () => sendToOperator('menu:project-consolidate'),
        },
        { type: 'separator' },
        { label: t('Текст'), submenu: [
          { label: t('Отменить ввод'), role: 'undo' }, { label: t('Повторить ввод'), role: 'redo' },
          { type: 'separator' }, { label: t('Вырезать'), role: 'cut' }, { label: t('Копировать'), role: 'copy' },
          { label: t('Вставить'), role: 'paste' }, { label: t('Выделить всё'), role: 'selectAll' },
        ] },
        {
          label: t('Добавить файлы в плейлист…'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToOperator('menu:open-pdf'),
        },
      ],
    },
    ...quickMenus(),
    {
      label: 'Help',
      submenu: [
        { label: t('О CueDeck'), click: () => void showAboutDialog() },
        { type: 'separator' },
        {
          label: t('Горячие клавиши…'),
          accelerator: 'Shift+/',
          click: () => sendToOperator('menu:help'),
        },
        { type: 'separator' },
        {
          // Тот же хоткей ловит и окно оператора по e.code (любая раскладка);
          // двойное срабатывание глушит markMoment.
          label: t('⚑ Отметить момент в журнале'),
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => markMoment('menu'),
        },
        {
          label: t('Сообщить о проблеме…'),
          click: () => openReportDialog(),
        },
        {
          label: t('Поддержка: @CueDeckSupport_Bot…'),
          click: () => shell.openExternal(SUPPORT_URL).catch(() => undefined),
        },
        ...(DONATE_URL
          ? ([
              { type: 'separator' },
              {
                label: t('☕ Поддержать проект…'),
                click: () => shell.openExternal(DONATE_URL).catch(() => undefined),
              },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
  ]
  setOperatorApplicationMenu(Menu.buildFromTemplate(template), getOperatorWindow())
}

function sendToOperator(channel: string, ...args: unknown[]): void {
  const op = getOperatorWindow()
  if (op && !op.isDestroyed()) op.webContents.send(channel, ...args)
}


/** Аварийный перезапуск посреди мероприятия не должен упираться в плашку. */
const QUIET_RESTART_MS = 10 * 60 * 1000

/**
 * Плашка поддержки — первым экраном при запуске, до выбора
 * раскладки. Пропускаем в двух случаях: приложение уже запускалось меньше
 * QUIET_RESTART_MS назад (значит это перезапуск в бою, не начало смены) и при
 * CUEDECK_NO_NAG=1 (разработка).
 */
async function bootNag(): Promise<void> {
  const previousLaunch = getLastLaunchAt()
  setLastLaunchAt(Date.now())
  if (process.env.CUEDECK_NO_NAG) return
  if (previousLaunch && Date.now() - previousLaunch < QUIET_RESTART_MS) return
  await showNagDialog()
}

async function bootLayout(): Promise<void> {
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const displayInfo = displays.map((d) => ({ id: d.id, internal: d.id === primaryId }))
  const audienceWindowed = getAudienceWindowed()
  const audienceAlwaysOnTop = getAudienceAlwaysOnTop()

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
  applyLayout(layout, displayMap, audienceWindowed, audienceAlwaysOnTop)
  saveMapping(store.get().layout, store.get().displayMap)
}

function watchDisplayChanges(): void {
  const onChange = () => sendToOperator('display:topology-changed')
  screen.on('display-added', onChange)
  screen.on('display-removed', onChange)
  screen.on('display-metrics-changed', onChange)
}

// Keep the escape route in main, on every window, including fullscreen outputs.
// Use the physical key so the shortcut also works with a Cyrillic keyboard layout.
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('before-input-event', (event, input) => {
    const modifier = process.platform === 'darwin' ? input.meta : input.control
    if (input.type !== 'keyDown' || input.code !== 'KeyD' || !modifier || !input.shift || input.alt || input.isAutoRepeat) return
    event.preventDefault()
    const operator = getOperatorWindow()
    if (!operator || operator.isDestroyed()) return
    const displayId = screen.getDisplayMatching(operator.getBounds()).id
    applyLayout('solo', { operator: displayId }, false, store.get().audienceAlwaysOnTop)
    saveMapping(store.get().layout, store.get().displayMap)
    const win = getOperatorWindow()
    win?.restore()
    win?.show()
    win?.focus()
  })
})

app.on('browser-window-focus', (_event, window) => {
  if (window === getOperatorWindow()) suspendClickerShortcuts()
})

app.on('browser-window-blur', (_event, window) => {
  if (window !== getOperatorWindow() || window.isDestroyed() || window.isFocused()) return
  const { clickerGlobal, clickerGlobalArrows } = store.get()
  if (clickerGlobal) applyClickerShortcuts(clickerGlobal, clickerGlobalArrows)
})

app.whenReady().then(async () => {
  // Relocate before opening windows or starting outputs. On a fresh install,
  // use the system language until the regular language picker is shown.
  setLang(getUiLang() ?? (app.getLocale().startsWith('ru') ? 'ru' : DEFAULT_LANG))
  if (await offerMacInstall()) return

  protocol.handle(MEDIA_SCHEME, handleMediaRequest)

  // Allow microphone/output-device access so enumerateDevices() returns real
  // device labels and <video>.setSinkId() works (routing video sound to a
  // chosen output: sound card / minijack / HDMI to vMix, etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)

  instrumentIpc()
  // Внешнее управление зовёт те же обработчики, что и кнопки оператора, —
  // запоминаем их при регистрации (remote/server.ts).
  captureIpcHandlers()
  registerIpcHandlers()
  registerProgramMirrorIpc()
  registerTestScreenIpc()
  registerAudienceOutputIpc()
  registerDiagIpc()
  registerRemoteIpc()
  registerProfileIpc()
  registerOmtIpc()
  registerOmtInputIpc()
  registerWindowCapture()
  initStream()

  // Язык — раньше меню и любых окон: всё дальше рисуется уже на нём. Не
  // выбран ни разу (первый запуск) — спросить (lang-dialog.ts).
  let uiLang = getUiLang()
  if (!uiLang) {
    const choice = await askUiLang(DEFAULT_LANG)
    uiLang = choice.lang
    if (choice.chosen) setUiLang(uiLang)
  }
  setLang(uiLang)
  buildMenu()
  store.onChange((_state, patch) => {
    if (['layout', 'displayMap', 'audienceOutputEnabled', 'audienceWindowed', 'testScreen', 'outputMonitorsEnabled', 'audioOutputId', 'previewAudioOutputId'].some(key => key in patch)) buildMenu()
  })
  screen.on('display-added', () => buildMenu())
  screen.on('display-removed', () => buildMenu())
  screen.on('display-metrics-changed', () => buildMenu())
  ipcMain.handle('menu:audio-outputs', (event, outputs: unknown) => {
    const op = getOperatorWindow()
    if (!op || event.sender !== op.webContents || event.senderFrame !== op.webContents.mainFrame) throw new Error('Operator window required')
    if (!Array.isArray(outputs) || outputs.length > 256 || outputs.some(d => !d || typeof d.id !== 'string' || typeof d.label !== 'string')) throw new Error('Invalid audio outputs')
    menuAudioOutputs = outputs.filter(d => d.id !== 'default').map(d => ({ id: d.id, label: d.label }))
    buildMenu()
  })

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

  // Смена языка в «Настройках» — через перезапуск; спросит о сохранении, как обычный выход.
  ipcMain.handle('app:relaunch', () => {
    // dev-сборка: окна грузятся с dev-сервера electron-vite, а его держит
    // `npm run dev` ровно до выхода этого процесса. После app.relaunch() новый
    // процесс открыл бы окна на мёртвом localhost:5173 — пустой экран. Поэтому
    // здесь без выхода: язык, меню и окна пересобираются на месте.
    if (process.env['ELECTRON_RENDERER_URL']) {
      const lang = getUiLang()
      if (lang) setLang(lang)
      buildMenu()
      reloadAllWindowsForLang()
      return
    }
    void requestQuit({ relaunch: true })
  })

  ipcMain.handle('external:open', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url).catch(() => undefined)
    }
  })

  // Restore preferences (timer settings, UI prefs) — session content loaded on demand via "Последний"
  store.patch({
    testScreen: { automatic: startupTestScreenAllowed({ playlist: getPlaylist(), lastPath: getLastPdfPath(), projectPath: getProjectPath(), keyVisualPath: getKeyVisualPath() }), manual: false },
    timer: { ...store.get().timer, durationMs: getLastDurationMs() },
    materialSettings: getMaterialSettings(),
    audienceTimer: createAudienceTimer(getAudienceTimer()),
    timerMode: getTimerMode(),
    timerPosition: getTimerPosition(),
    timerScale: getTimerScale(),
    timerFree: getTimerFree(),
    timerFont: getTimerFont(),
    timerColor: getTimerColor(),
    timerWarnColors: getTimerWarnColors(),
    speakerToolbarScale: getSpeakerToolbarScale(),
    speakerLayout: getSpeakerLayout(),
    speakerMsgLayout: getSpeakerMsgLayout(),
    videoTakeMode: getVideoTakeMode(),
    slideTakeMode: getSlideTakeMode(),
    takeFadeMs: getTakeFadeMs(),
    notesFontSize: getNotesFontSize(),
    playlistCompact: getPlaylistCompact(),
    autoAdvance: getAutoAdvance(),
    audienceWindowed: getAudienceWindowed(),
    audienceAlwaysOnTop: getAudienceAlwaysOnTop(),
    audioOutputId: getAudioOutputId(),
    previewAudioOutputId: getPreviewAudioOutputId(),
    timerTickEnabled: getTimerTickEnabled(),
    timerGongEnabled: getTimerGongEnabled(),
    timerLoop: getTimerLoop(),
    speakerMsgPresets: getSpeakerMsgPresets(),
    timerPresets: getTimerPresets(),
    timerAdjustments: getTimerAdjustments(),
    playlistDoubleClickTake: getPlaylistDoubleClickTake(),
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

  // Слушатели Stream Deck / Companion — до диалогов старта: пока оператор
  // выбирает раскладку, кнопки уже должны отвечать, а не сыпать ошибками.
  await initRemote()
  initOmt()

  setOperatorWindowHook(attachOperatorCloseGuard)
  await bootNag()
  await bootLayout()
  booting = false
  watchDisplayChanges()
  startOutputMonitor()
  initSyphonBridge()
  initSyphonGpuProbe()
  initSyphonGpuAudience()
  initLoopProbe()

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

/**
 * Стартовые окна (язык, плашка, раскладка) идут по одному, и между ними окон
 * нет вовсе — на Windows это `window-all-closed`, и без этой проверки
 * программа закрылась бы, не успев открыться.
 */
let booting = true

app.on('window-all-closed', async () => {
  if (booting) return
  await flushPendingWrites()
  if (process.platform !== 'darwin') app.quit()
})

// Cmd+Q / Alt+F4 / меню → тот же путь, что и крестик окна оператора:
// спросить, дописать файлы, выйти (quit-guard.ts).
app.on('before-quit', (e) => {
  if (isMovingToApplications()) {
    markCleanExit()
    return
  }
  e.preventDefault()
  void requestQuit()
})
